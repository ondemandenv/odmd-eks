import * as cdk from 'aws-cdk-lib';
import {StackProps} from "aws-cdk-lib";
import {GyangEksCluster} from "../lib/eks-stack";
import {OndemandContractsSandbox} from "@ondemandenv/odmd-contracts-sandbox";
import {EksClusterEnverSbx} from "@ondemandenv/odmd-contracts-sandbox/lib/repos/_eks/odmd-build-eks-sbx";
import {SimpleK8sManifestStack} from "../lib/simple-k8s-manifest";


const cdkApp = new cdk.App();

async function main() {

    const buildRegion = process.env.CDK_DEFAULT_REGION;
    const buildAccount = process.env.CDK_DEFAULT_ACCOUNT
        ? process.env.CDK_DEFAULT_ACCOUNT
        : process.env.CODEBUILD_BUILD_ARN!.split(":")[4];
    if (!buildRegion || !buildAccount) {
        throw new Error("buildRegion>" + buildRegion + "; buildAccount>" + buildAccount)
    }

    const props = {
        env: {
            account: buildAccount,
            region: buildRegion
        }
    } as StackProps;

    new OndemandContractsSandbox(cdkApp)

    const myEnver = OndemandContractsSandbox.inst.getTargetEnver() as EksClusterEnverSbx

    const eksStack = new GyangEksCluster(cdkApp, myEnver.getRevStackNames()[0], props)

    new SimpleK8sManifestStack(cdkApp, 'K8sManifestStack', {...props, cluster: eksStack.eksCluster})

}

console.log("main begin.")
main().catch(e => {
    console.error("main>>>")
    console.error(e)
    console.error("main<<<")
    throw e
}).finally(() => {
    console.log("main end.")
})
