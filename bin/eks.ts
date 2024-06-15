import * as cdk from 'aws-cdk-lib';
import {StackProps} from "aws-cdk-lib";
import {GyangEksCluster} from "../lib/eks-stack";
import {CurrentEnver} from "./current-enver";
import * as fs from "fs";
import {KubeCtlThruCentral, OndemandContracts} from "@ondemandenv/odmd-contracts";

if (!process.env.CDK_CLI_VERSION) {
    throw new Error("have to have process.env.CDK_CLI_VERSION!")
}

const region = process.env.CDK_DEFAULT_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT
    ? process.env.CDK_DEFAULT_ACCOUNT
    : process.env.CODEBUILD_BUILD_ARN!.split(":")[4];
if (!region || !account) {
    throw new Error("region>" + region + "; account>" + account)
}

async function main() {
    const cdkApp = new cdk.App({autoSynth: false});

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

    new OndemandContracts(cdkApp)
    await CurrentEnver.init()

    const theClusterStack = new GyangEksCluster(cdkApp, CurrentEnver.inst.eksCluster.getRevStackNames()[0], props)


    OndemandContracts.inst.odmdBuilds.forEach(b => {
        b.envers.forEach(e => {
            const t = e as any as KubeCtlThruCentral
            if (t && t.simpleK8s && t.simpleK8s.targetEksCluster == CurrentEnver.inst.eksCluster) {
                //ONDEMAND_CENTRAL_REPO\lib\repo-build-pp-cdk.ts will auto delete this
                // new KubectlSg(cdkApp, theClusterStack, t)
            }
        })
    })


    const stackNameToClass = {} as { [key: string]: string[] }
    const cdkResNodeInfo = {} as { [key: string]: string[] }
    cdkApp.node.findAll().forEach(c => {
        if (c instanceof cdk.Stack) {
            cdk.Tags.of(c).add('owner', 'dev@ondemandenv.dev')

            c.templateOptions.description = c.constructor.name
                .replace(/ghapp/gi, '917h6@pp')
                .replace(/ondemand/gi, '0nd3@n9')
                .replace(/account/gi, '@cc4nt')
            stackNameToClass[c.stackName] = [
                c.constructor.name,
                c.templateOptions.description
            ]
        }

        if (c instanceof cdk.CfnElement) {
            const logicalId = c.stack.getLogicalId(c);
            cdkResNodeInfo[c.node.path] = [`${c.stack.stackName}/${logicalId}, ${c.stack.constructor.name}/${c.constructor.name}`]
            cdk.Tags.of(c).add("logicalId", logicalId)
            // cdk.Tags.of(c).add("stackId", c.stack.stackId)
            cdk.Tags.of(c).add("stackName", c.stack.stackName)
        }
    })

    cdkApp.synth();
    fs.writeFileSync('gen-stack-to-class.json', JSON.stringify(stackNameToClass, undefined, '\t'))
    fs.writeFileSync('gen-cdk-res.json', JSON.stringify(cdkResNodeInfo, undefined, '\t'))
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
