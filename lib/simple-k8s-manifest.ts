import {Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {Cluster} from "aws-cdk-lib/aws-eks";
import {StringParameter} from "aws-cdk-lib/aws-ssm";
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kplus from 'cdk8s-plus-31';
import * as cdk8s from 'cdk8s';


/**
 * this stack illustrates Application-Centric Infrastructure:
 *     resources k8s deployment inside EKs cluster
 *     resources the dynamodb table outside
 * are logically same application,
 * and dependencies are maintained by Cloudformation
 *
 *
 * Note:
 * 1) this stack is not fully working yet as AWS CDK's EKS and cdk8s support is still under development ...
 *      a) VPC, SG, IAM all have to match exactly to make Cluster.fromClusterAttributes work, and have to be in same account/region.
 *      b) all dynamic values like imageAndVersion are not supported, because the
 *         https://github.com/aws/aws-cdk/tree/main/packages/%40aws-cdk/custom-resource-handlers/lib/aws-eks/kubectl-handler
 *         is implemented completely wrong.
 *
 * 2) ondemandenv's implementation support cross accounts k8s manifest deployment with dynamic values:
 * EKsManifest https://github.com/ondemandenv/odmd-contracts-base/blob/main/lib/model/odmd-eks-manifest.ts
 *
 */
export class SimpleK8sManifestStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps & { cluster: Cluster }) {
        super(scope, id, props);

        // const cluster = props.cluster;// this is going to deploy manifest to the cluster's stack!
        const cluster = Cluster.fromClusterAttributes(this, 'my_cluster', {
            clusterName: props.cluster.clusterName,
            kubectlRoleArn: props.cluster.kubectlRole?.roleArn,
            vpc: props.cluster.vpc,
            // probably need more to make this work
        })

        const appNamespace = cluster.addManifest('app-namespace', {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: 'my-app-namespace',
            },
        });

        const imageAndVersion = StringParameter.valueForStringParameter(this, '/my-app/nginx-image-and-version');

        // Define DynamoDB Table
        const dynamoTable = new dynamodb.Table(this, 'MyAppTable', {
            partitionKey: {name: 'id', type: dynamodb.AttributeType.STRING},
        });

        const appDeployment = cluster.addManifest('app-deployment',
            this.createManifest(imageAndVersion, dynamoTable.tableName)
        );

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
                ports: [{port: 80, targetPort: 80}],
                type: 'LoadBalancer',
            },
        });

        // Define dependency to ensure namespace is created before deployment and service
        appDeployment.node.addDependency(appNamespace);
        appService.node.addDependency(appDeployment);
    }


    //https://cdk8s.io/docs/latest/plus/cdk8s-plus-31/deployment/
    private createManifest(imageAndVersion: string, tableName: string) {
        const app = new cdk8s.App()
        const chart = new cdk8s.Chart(app, 'MyAppTable')

        new kplus.Deployment(chart, 'MyAppTable', {
            containers: [
                {
                    name: 'my-app-container',
                    image: `${imageAndVersion}`,
                    ports: [{number: 80}],
                    envVariables: {
                        DYNAMODB_TABLE_NAME: {value: tableName},
                    }
                },]
        })
        return chart.toJson()
    }

}