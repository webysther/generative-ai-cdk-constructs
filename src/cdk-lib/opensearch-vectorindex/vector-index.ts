/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as oss from 'aws-cdk-lib/aws-opensearchserverless';
import { Construct } from 'constructs';
import { buildCustomResourceProvider } from '../../common/helpers/custom-resource-provider-helper';
import { generatePhysicalNameV2 } from '../../common/helpers/utils';
import { VectorCollection } from '../opensearchserverless';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { NagSuppressions } from 'cdk-nag/lib/nag-suppressions';

/**
 * Metadata field definitions.
 */
export interface MetadataManagementFieldProps {
  /**
   * The name of the field.
   */
  readonly mappingField: string;
  /**
   * The data type of the field.
   */
  readonly dataType: string;
  /**
   * Whether the field is filterable.
   */
  readonly filterable: boolean;
}

/**
 * Metadata field definitions as the API expects them.
 *
 * @internal - JSII requires the exported interface to have camel camelCase properties,
 * but the API expect PascalCase properties
 */
type MetadataManagementField = {
  /**
   * The name of the field.
   */
  readonly MappingField: string;
  /**
   * The data type of the field.
   */
  readonly DataType: string;
  /**
   * Whether the field is filterable.
   */
  readonly Filterable: boolean;
}

/**
 * Properties for the Custom::OpenSearchIndex custom resource.
 *
 * @internal
 */
interface VectorIndexResourceProps {
  /**
   * The OpenSearch Endpoint.
   */
  readonly Endpoint: string;
  /**
   * The name of the index.
   */
  readonly IndexName: string;
  /**
   * The name of the vector field.
   */
  readonly VectorField: string;
  /**
   * The number of dimensions in the vector.
   */
  readonly Dimensions: number;
  /**
   * The metadata management fields.
   */
  readonly MetadataManagement: MetadataManagementField[];
}

/**
 * Properties for the VectorIndex.
 */
export interface VectorIndexProps {
  /**
   * The OpenSearch Vector Collection.
   */
  readonly collection: VectorCollection;
  /**
   * The name of the index.
   */
  readonly indexName: string;
  /**
   * The name of the vector field.
   */
  readonly vectorField: string;
  /**
   * The number of dimensions in the vector.
   */
  readonly vectorDimensions: number;
  /**
   * The metadata management fields.
   */
  readonly mappings: MetadataManagementFieldProps[];
}

/**
 * Deploy a vector index on the collection.
 */
export class VectorIndex extends cdk.Resource {
  /**
   * The name of the index.
   */
  public readonly indexName: string;
  /**
   * The name of the vector field.
   */
  public readonly vectorField: string;
  /**
   * The number of dimensions in the vector.
   */
  public readonly vectorDimensions: number;

  constructor(
    scope: Construct,
    id: string,
    props: VectorIndexProps,
  ) {
    super(scope, id);

    this.indexName = props.indexName;
    this.vectorField = props.vectorField;
    this.vectorDimensions = props.vectorDimensions;

    
    // const customResourceLayer = new lambda.LayerVersion(this, 'CustomResourceLayer', {
    //   code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambda/opensearch-serverless-custom-resources/custom-resource-layer/')),
    //   compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
    // });

    this.installDependencies('../../../lambda/opensearch-serverless-custom-resources/custom-resource-layer', [
      'boto3>=1.33.6',
      'opensearch-py>=2.4.2',
      'tenacity>=8.2.3',
    ]);

    const customResourceLayer = this.createLambdaLayer('../../../lambda/opensearch-serverless-custom-resources/custom-resource-layer')

    const OpenSearchIndexCRProvider = buildCustomResourceProvider({
      providerName: 'OpenSearchIndexCRProvider',
      codePath: path.join(
        __dirname, '../../../lambda/opensearch-serverless-custom-resources'),
      handler: 'custom_resources.on_event',
      runtime: lambda.Runtime.PYTHON_3_12,
      layers: [customResourceLayer]
    });

    const crProvider = OpenSearchIndexCRProvider.getProvider(this);
    crProvider.role.addManagedPolicy(props.collection.aossPolicy);

    const manageIndexPolicyName = generatePhysicalNameV2(this,
      'ManageIndexPolicy',
      { maxLength: 32, lower: true });
    const manageIndexPolicy = new oss.CfnAccessPolicy(this, 'ManageIndexPolicy', {
      name: manageIndexPolicyName,
      type: 'data',
      policy: JSON.stringify([
        {
          Rules: [
            {
              Resource: [`index/${props.collection.collectionName}/*`],
              Permission: [
                'aoss:DescribeIndex',
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
                'aoss:UpdateIndex',
              ],
              ResourceType: 'index',
            },
            {
              Resource: [`collection/${props.collection.collectionName}`],
              Permission: [
                'aoss:DescribeCollectionItems',
              ],
              ResourceType: 'collection',
            },
          ],
          Principal: [
            crProvider.role.roleArn,
          ],
          Description: '',
        },
      ]),
    });


    const vectorIndex = new cdk.CustomResource(this, 'VectorIndex', {
      serviceToken: crProvider.serviceToken,
      properties: {
        Endpoint: `${props.collection.collectionId}.${cdk.Stack.of(this).region}.aoss.amazonaws.com`,
        IndexName: props.indexName,
        VectorField: props.vectorField,
        Dimensions: props.vectorDimensions,
        MetadataManagement: props.mappings.map((m) => {
          return {
            MappingField: m.mappingField,
            DataType: m.dataType,
            Filterable: m.filterable,
          };
        }),
      } as VectorIndexResourceProps,
      resourceType: 'Custom::OpenSearchIndex',
    });

    vectorIndex.node.addDependency(manageIndexPolicy);
    vectorIndex.node.addDependency(props.collection);
    vectorIndex.node.addDependency(props.collection.dataAccessPolicy);

    
  }
  

  private createLambdaLayer(layerDir: string): lambda.LayerVersion {
    
    const accesslogBucket = new s3.Bucket(this, 'AccessLogsLayers', {
      enforceSSL: true,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    NagSuppressions.addResourceSuppressions(accesslogBucket, [
      {id: 'AwsSolutions-S1', reason: 'There is no need to enable access logging for the AccessLogs bucket.'},
    ])
    const layerBucket = new s3.Bucket(this, 'DocBucket', {
      enforceSSL: true,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: accesslogBucket,
      serverAccessLogsPrefix: 'layerAssetsBucketLogs/',
    });

  
    const s3Key = 'layer.zip';
    const s3Asset = new assets.Asset(this, `Asset`, {
      path: layerDir,
      assetHash: `${layerDir}-hash`,
    });
  
    s3Asset.node.addDependency(layerBucket);


    // return new lambda.LayerVersion(this, `Layer`, {
    //   code: lambda.Code.fromAsset(layerDir),
    //   compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
    // });

    return new lambda.LayerVersion(this, `Layer`, {
      code: lambda.Code.fromBucket(layerBucket, s3Key),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
    });
  }

  private installDependencies(layerDir: string, requirements: string[]): void {
    const sitePackagesDir = path.join(layerDir, 'python', 'lib', 'python3.12', 'site-packages');
    fs.mkdirSync(sitePackagesDir, { recursive: true });
    child_process.execSync(`pip install -t ${sitePackagesDir} ${requirements.join(' ')}`, {
      stdio: 'inherit',
    });
  }
}



/**
 * Custom Resource provider for OpenSearch Index operations.
 *
 * @internal This is an internal core function and should not be called directly by Solutions Constructs clients.
 */
// export const OpenSearchIndexCRProvider = buildCustomResourceProvider({
//   providerName: 'OpenSearchIndexCRProvider',
//   codePath: path.join(
//     __dirname, '../../../lambda/opensearch-serverless-custom-resources'),
//   handler: 'custom_resources.on_event',
//   runtime: lambda.Runtime.PYTHON_3_12,
//   layers: [customResourceLayer]
// });