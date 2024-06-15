import * as k8s from "@kubernetes/client-node"
import * as b64 from "base-64"
import {execSync} from 'child_process';




process.env.CDK_CLI_VERSION = '2.114.1'
process.env.CDK_DEFAULT_ACCOUNT = '590184130740'
process.env.target_rev_ref = 'b:odmdSbxUsw1Gyang'
process.env.CDK_DEFAULT_REGION = 'us-west-1'


import * as net from "net";
import {CurrentEnver} from "./current-enver";
import {App} from "aws-cdk-lib";
import {OndemandContracts} from "@ondemandenv/odmd-contracts";

const eks_profile = 'AdministratorAccess-590184130740'
async function updateKubectl() {
    let targetAccId = CurrentEnver.inst.eksCluster.targetAWSAccountID;
    if( !eks_profile.includes(targetAccId)){
        throw new Error( ' ??? ')
    }
    execSync(`aws sts get-caller-identity --profile ${eks_profile}`)
    execSync(`aws eks update-kubeconfig --name ${CurrentEnver.inst.eksCluster.clusterName} --profile ${eks_profile}`)
}

async function printSecresAndPortforwardArgo() {

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

    const lstAllResp = await k8sApi.listNamespacedSecret(CurrentEnver.inst.localConfig.argocdNamespace!)
    const i = lstAllResp.body.items.find(i => i.metadata?.name == 'argocd-initial-admin-secret')!
    for (const t in i.data) {
        console.log(`${t} >> ${b64.decode(i.data[t])}`)
    }

    const forwarding = new k8s.PortForward(kc);

// Define the namespace and the service name you want to forward the port to
    const namespace = CurrentEnver.inst.localConfig.argocdNamespace!
    const serviceName = CurrentEnver.inst.localConfig.argocdRelease! + '-argocd-server'

// First, get the service to find the selector
    const serviceResponse = await k8sApi.readNamespacedService(serviceName, namespace)
    const selectors = serviceResponse.body.spec!.selector!;
    const labelSelector = Object.entries(selectors)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');

    // Now, list the pods using the service's selector to find a matching pod
    const podsResponse = await k8sApi.listNamespacedPod(
        namespace,
        undefined, undefined, undefined, undefined,
        labelSelector
    );
    const pods = podsResponse.body.items;
    if (pods.length === 0) {
        throw new Error('No pods found for this service');
    }

    // Just use the first pod for port forwarding
    const podName = pods[0].metadata!.name!;

    // Setup port forwarding - replace 8080 with your target port
    const targetPort = 8080;


    const server = net.createServer((socket) => {
        forwarding.portForward(namespace, podName, [targetPort], socket, process.stderr, socket);
    });

    server.listen(8080, '127.0.0.1');

}


async function main() {

    new OndemandContracts( new App(), {
        central: '590184031795',
        networking: '590183907424',
        workplace1: '975050243618',
        workplace2: '590184130740'
    })
    await CurrentEnver.init()
    await updateKubectl()
    await printSecresAndPortforwardArgo()
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
