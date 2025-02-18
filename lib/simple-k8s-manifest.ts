import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {Cluster} from "aws-cdk-lib/aws-eks";
import {StringParameter} from "aws-cdk-lib/aws-ssm";
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'; // Import DynamoDB module



export class SimpleK8sManifestStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps & { cluster: Cluster }) {
        super(scope, id, props);

        const cluster = props.cluster;

        // Define Kubernetes Manifest
        const appNamespace = cluster.addManifest('app-namespace', {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: 'my-app-namespace',
            },
        });

        // Load  image version from Parameter Store
        const imageAndVersion = StringParameter.valueForStringParameter(this, '/my-app/nginx-image-and-version');

        // Define DynamoDB Table
        const dynamoTable = new dynamodb.Table(this, 'MyAppTable', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        });


        const appDeployment = cluster.addManifest('app-deployment', {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
                namespace: 'my-app-namespace',
                name: 'my-app-deployment',
            },
            spec: {
                replicas: 3,
                selector: {
                    matchLabels: {
                        app: 'my-app',
                    },
                },
                template: {
                    metadata: {
                        labels: {
                            app: 'my-app',
                        },
                    },
                    spec: {
                        containers: [
                            {
                                name: 'my-app-container',
                                image: `${imageAndVersion}`,
                                ports: [{ containerPort: 80 }],
                                env: [
                                    {
                                        name: 'DYNAMODB_TABLE_NAME',
                                        value: dynamoTable.tableName
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
        });

        const appService = cluster.addManifest('app-service', {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: {
                namespace: 'my-app-namespace',
                name: 'my-app-service',
            },
            spec: {
                selector: {
                    app: 'my-app',
                },
                ports: [{ port: 80, targetPort: 80 }],
                type: 'LoadBalancer',
            },
        });

        // Define dependency to ensure namespace is created before deployment and service
        appDeployment.node.addDependency(appNamespace);
        appService.node.addDependency(appDeployment);
    }
}