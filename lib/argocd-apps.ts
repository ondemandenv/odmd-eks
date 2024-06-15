import {Construct} from "constructs";
import {Application, AppProject, AppProjectProps} from "../imports/argocd-argoproj.io";
import * as fs from "fs";
import {Chart, YamlOutputType, App} from "cdk8s";
import {
    ApplicationProps,
    ApplicationSpecDestination,
    ApplicationSpecSource, ApplicationSpecSyncPolicy
} from "@ondemandenv/odmd-contracts/imports/argocd-argoproj.io";
import {GyangEksCluster} from "./eks-stack";
import {CfnJson, CustomResource, Duration, Stack} from "aws-cdk-lib";
import {CurrentEnver} from "../bin/current-enver";
import {OpenIdConnectPrincipal, Policy, PolicyStatement, Role, User} from "aws-cdk-lib/aws-iam";
import {Provider} from "aws-cdk-lib/custom-resources";
import * as path from "node:path";
import {Runtime} from "aws-cdk-lib/aws-lambda";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";
import {OdmdNames, OndemandContracts} from "@ondemandenv/odmd-contracts";
import {ContractsEnverEcrToEksArgo} from "@ondemandenv/odmd-contracts/lib/odmd-model/contracts-enver-ecr-to-eks-argo";

export class ArgocdApps extends Construct {

    readonly appOfApps = 'app-of-apps';
    public readonly argocdRepoRole: Role;

    constructor(gyangEksCluster: GyangEksCluster, id: string) {
        super(gyangEksCluster, id);

        const argoDefHelmOptions = gyangEksCluster.argoDefHelmOptions

        const cdk8App = new App({
            yamlOutputType: YamlOutputType.FILE_PER_CHART,
        });
        const rootAppOfApps = new Chart(cdk8App, this.appOfApps, {namespace: argoDefHelmOptions.namespace});

        const cdk8sRepoUrl = `https://git-codecommit.${gyangEksCluster.region}.amazonaws.com/v1/repos/${gyangEksCluster.argocdRepoName}`

        const issuer = gyangEksCluster.eksCluster.openIdConnectProvider.openIdConnectProviderIssuer
        const roleName = OdmdNames.create(CurrentEnver.inst.eksCluster, 'argocd-repo-sa');
        this.argocdRepoRole = new Role(gyangEksCluster, 'argocd-repo-sa', {
            roleName,
            assumedBy: new OpenIdConnectPrincipal(gyangEksCluster.eksCluster.openIdConnectProvider).withConditions({
                StringEquals: new CfnJson(this, 'argocd-repo-sa-condition', {
                    value: {
                        [`${issuer}:aud`]: 'sts.amazonaws.com',
                        [`${issuer}:sub`]: `system:serviceaccount:${CurrentEnver.inst.localConfig.argocdNamespace}:${CurrentEnver.inst.localConfig.argocdRepoSA}`,
                    },
                }),
            })
        })
        gyangEksCluster.argocdRepo.grantRead(this.argocdRepoRole)
        gyangEksCluster.argocdRepo.grantRead(new User(gyangEksCluster, 'argocd-reader', {userName: 'argocd-reader'}))

        gyangEksCluster.eksCluster.addServiceAccount('argocd-repo-server-sa', {
            name: CurrentEnver.inst.localConfig.argocdRepoSA,
            namespace: CurrentEnver.inst.localConfig.argocdNamespace,
            annotations: {"eks.amazonaws.com/role-arn": `arn:aws:iam::${gyangEksCluster.account}:role/${roleName}`}
        });

        gyangEksCluster.eksCluster.addManifest('argocd-def', new Application(rootAppOfApps, 'argocd-def', {
            metadata: {
                name: 'argocd-def',
            },
            spec: {
                project: 'default',
                source: {
                    repoUrl: argoDefHelmOptions.repository!,
                    chart: argoDefHelmOptions.chart,
                    targetRevision: argoDefHelmOptions.version,

                    helm: {
                        releaseName: argoDefHelmOptions.release,
                        valuesObject: argoDefHelmOptions.values
                    }
                },
                destination: {
                    server: 'https://kubernetes.default.svc',
                    namespace: argoDefHelmOptions.namespace
                },
                syncPolicy: {
                    syncOptions: ['CreateNamespace=false', 'Replace=true']
                } as ApplicationSpecSyncPolicy
            }
        }).toJson())
        gyangEksCluster.eksCluster.addManifest('seed-argocd-app', new Application(rootAppOfApps, 'app-of-apps', {
            metadata: {
                name: this.appOfApps
            },
            spec: {
                project: 'default',
                source: {
                    repoUrl: cdk8sRepoUrl,
                    targetRevision: 'main',
                    path: this.appOfApps,
                },
                destination: {
                    server: 'https://kubernetes.default.svc',
                    namespace: argoDefHelmOptions.namespace
                },
                syncPolicy: {
                    syncOptions: ['CreateNamespace=false', 'Replace=true']
                } as ApplicationSpecSyncPolicy
            }
        }).toJson())

        const myEnvers = new Array<ContractsEnverEcrToEksArgo>()
        OndemandContracts.inst.odmdBuilds.forEach(cc => {
            myEnvers.push(...
                cc.envers.filter(ccev => ccev instanceof ContractsEnverEcrToEksArgo)
                    .map(ccev => ccev as ContractsEnverEcrToEksArgo)
                    .filter(ccev => ccev.argocdEksEnv == CurrentEnver.inst.eksCluster)
            )
        })

        const buildToDefaultProj = new Map<string, AppProjectProps>()

        function getAppProject(e: ContractsEnverEcrToEksArgo) {
            if (!buildToDefaultProj.has(e.owner.buildId)) {
                const props = {
                    metadata: {
                        name: e.owner.buildId
                    },
                    spec: {
                        sourceRepos: [cdk8sRepoUrl],
                        destinations:[{
                            server: 'https://kubernetes.default.svc',
                            namespace: e.targetRevision.type + '_' + e.targetRevision.value
                        }]
                    }
                } as AppProjectProps;
                buildToDefaultProj.set(e.owner.buildId, props)
            }
            return buildToDefaultProj.get(e.owner.buildId)!;
        }

        myEnvers.forEach(e => {
            if (!e.argocdProj) {
                // @ts-ignore
                e.argocdProj = getAppProject(e)
            }
            if (!e.argocdApp) {
                // @ts-ignore
                e.argocdApp = {
                    metadata: {name: (e.owner.buildId + '-' + e.targetRevision).replace(/[^a-z0-9-]/g, '')},
                    spec: {project: e.argocdProj!.metadata.name}
                } as ApplicationProps
            }

            // e.ecrSrcEnv//todo: not used here but by the build will use this
            // e.eksDestEnv//todo: how to know dest's api server uri

            // @ts-ignore
            e.argocdApp.spec.source = {
                repoUrl: cdk8sRepoUrl,
                targetRevision: 'main',
                path: e.owner.buildId + '/' + e.targetRevision,
            } as ApplicationSpecSource

            // @ts-ignore
            e.argocdApp.spec.destination = {
                namespace: e.targetRevision,
                server: 'https://kubernetes.default.svc'//todo: use e.eksDestEnv
            } as ApplicationSpecDestination

            if (!e.argocdApp.spec.syncPolicy) {
                // @ts-ignore
                e.argocdApp.spec.syncPolicy = {
                    syncOptions: ['CreateNamespace=true', 'Replace=true'],
                    automated: {prune: true, allowEmpty: true, selfHeal: true}
                } as ApplicationSpecSyncPolicy
            }
        })

        new Set(myEnvers.map(e => e.argocdProj!)).forEach(p => {
            new AppProject(rootAppOfApps, 'prj-' + p.metadata.name!, p)
        })

        myEnvers.forEach(e => {
            new Application(rootAppOfApps, e.argocdApp!.metadata.name!, e.argocdApp!)
        })

        fs.rmSync('dist', {recursive: true, force: true})

        cdk8App.synth()

        const dirrd = fs.readdirSync('dist')
        dirrd.forEach(fname => {
            if (fname.endsWith(cdk8App.outputFileExtension)) {
                const fnNoExt = fname.substring(0, fname.length - cdk8App.outputFileExtension.length);
                const folder = 'dist/' + fnNoExt;
                fs.mkdirSync(folder)
                fs.renameSync('dist/' + fname, folder + '/manifest.yaml',)
            }
        })

        const nodejsFunction = new NodejsFunction(this, 'update-argocd-appOfApps', {
            runtime: Runtime.NODEJS_18_X,
            entry: path.join(__dirname, 'update-argocd-appOfApps/index.ts'),
            timeout: Duration.minutes(2),
            environment: {
                NODE_OPTIONS: '--unhandled-rejections=strict'
            }
        });
        const pushcs = new CustomResource(this, 'pushManifests-cs', {
            serviceToken: new Provider(this, 'pushManifests-cs-provider', {
                onEventHandler: nodejsFunction
            }).serviceToken,
            properties: {
                repositoryName: gyangEksCluster.argocdRepoName,
                filePath: this.appOfApps + '/manifest.yaml',
                branch: 'main',
                fileContent: fs.readFileSync(`dist/${this.appOfApps}/manifest.yaml`).toString(),
            }
        })

        const fullAccessToArgoRepo = new Policy(this, 'fullAccessToArgoRepo', {
            statements: [
                new PolicyStatement({
                    actions: ['*'],
                    resources: [gyangEksCluster.argocdRepo.repositoryArn]
                })
            ]
        });

        nodejsFunction.role!.attachInlinePolicy(fullAccessToArgoRepo)
        pushcs.node.addDependency(fullAccessToArgoRepo)
    }


}