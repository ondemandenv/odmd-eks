import {CfnJson, CfnOutput, Stack, StackProps} from "aws-cdk-lib";
import {Construct} from "constructs";
import {
    CfnRoute,
    CfnTransitGatewayAttachment,
    IpAddresses, ISecurityGroup, ISubnet,
    Peer,
    Port,
    SubnetType,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {Key} from "aws-cdk-lib/aws-kms";
import {
    ArnPrincipal,
    ManagedPolicy,
    OpenIdConnectPrincipal,
    Policy,
    PolicyDocument,
    PolicyStatement,
    Role
} from "aws-cdk-lib/aws-iam";
import {KubectlV28Layer} from "@aws-cdk/lambda-layer-kubectl-v28";
import * as eks from "aws-cdk-lib/aws-eks";
import {ArgocdApps} from "./argocd-apps";
import {Cluster, HelmChartOptions} from "aws-cdk-lib/aws-eks";
import {CurrentEnver} from "../bin/current-enver";
import {Repository} from "aws-cdk-lib/aws-codecommit";
import {
    ContractsCrossRefProducer,
    ContractsShareOut,
    OdmdNames,
    OndemandContracts,
    AnyContractsEnVer
} from "@ondemandenv/odmd-contracts";

export class GyangEksCluster extends Stack {
    public readonly eksCluster: Cluster;
    private argocdApps: ArgocdApps;
    public readonly argoDefHelmOptions: HelmChartOptions;
    public readonly argocdRepo: Repository
    public readonly argocdRepoName: string;

    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const clusterKmsKey = new Key(this, 'ekskmskey', {
            enableKeyRotation: true,
            alias: this.stackName + '/eks-kms',
        });

        const ipamWest1Le = OndemandContracts.inst.networking.ipam_west1_le;
        const ipv4IpamPoolId = CurrentEnver.inst.eksCluster.ipamPoolName.getSharedValue(this)
        const vpc = new Vpc(this, 'gyang-tst-vpc', {
            ipAddresses: IpAddresses.awsIpamAllocation({
                ipv4IpamPoolId,
                // defaultSubnetIpv4NetmaskLength: 26,
                ipv4NetmaskLength: 23
            }),
            maxAzs: 2,
            subnetConfiguration: [
                {
                    subnetType: SubnetType.PUBLIC,
                    name: 'public',
                    cidrMask: 28,
                },
                {
                    subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                    name: 'private1',
                    cidrMask: 26,
                },
                {
                    subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                    name: 'private2',
                    cidrMask: 26,
                }
            ],
            natGateways: 1,
        });

        const azToSbs = vpc.privateSubnets.reduce((p, v) => {
            const k = v.availabilityZone
            if (!p.has(k)) {
                p.set(k, [])
            }
            p.get(k)!.push(v)
            return p
        }, new Map<string, ISubnet[]>)

        const tgwAttach = new CfnTransitGatewayAttachment(this, 'tgwAttach', {
            vpcId: vpc.vpcId, subnetIds: Array.from(azToSbs.values()).map(s => s[0].subnetId),
            transitGatewayId: CurrentEnver.inst.eksCluster.transitGatewayShareName.getSharedValue(this)
        })

        vpc.privateSubnets.forEach((s, si) => {
            ipamWest1Le.cidrs.forEach((cidr, cdi) => {
                const r = new CfnRoute(this, `tgw-${si}-${cidr}`, {
                    routeTableId: s.routeTable.routeTableId,
                    destinationCidrBlock: cidr,
                    transitGatewayId: tgwAttach.transitGatewayId
                })
                r.addDependency(tgwAttach)
            })
        })

        const gyangAdm = Role.fromRoleName(this, 'gyang-admin', 'AWSReservedSSO_AdministratorAccess_f858ff41eadffbb9');

        // const pubIPs = ['67.80.162.234/32']
        const pubIPs = ['67.80.162.234/32', CurrentEnver.inst.eksCluster.natPublicIP.getSharedValue(this) + '/32'];
        this.eksCluster = new eks.Cluster(this, 'gyang-tst-eks-cluster', {
            clusterName: CurrentEnver.inst.eksCluster.clusterName,
            version: eks.KubernetesVersion.V1_28,
            kubectlLayer: new KubectlV28Layer(this, 'kubectl'),
            vpc,
            secretsEncryptionKey: clusterKmsKey,
            placeClusterHandlerInVpc: true,
            // endpointAccess: eks.EndpointAccess.PRIVATE,
            endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...pubIPs),
            // mastersRole: gyangAdm,
            albController: {version: eks.AlbControllerVersion.V2_6_2},
            defaultCapacity: 1
        })

        this.eksCluster.awsAuth.addMastersRole(gyangAdm)
        const openIdConnectProviderIssuer = this.eksCluster.openIdConnectProvider.openIdConnectProviderIssuer;

        const eksOicp = new OpenIdConnectPrincipal(this.eksCluster.openIdConnectProvider).withConditions({
            StringEquals: new CfnJson(this, 'awsVpcCniconditionPolicy', {
                value: {
                    [`${openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
                    [`${openIdConnectProviderIssuer}:sub`]: 'system:serviceaccount:kube-system:aws-node',
                },
            }),
        });

        const awsVpcCniRole = new Role(this, 'awsVpcCniRole', {
            assumedBy: eksOicp,
        });


        awsVpcCniRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'));
        new eks.CfnAddon(this, 'vpc-cni', {
            addonName: 'vpc-cni',
            resolveConflicts: 'OVERWRITE',
            serviceAccountRoleArn: awsVpcCniRole.roleArn,
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.16.0-eksbuild.1',
        })
        new eks.CfnAddon(this, 'kube-proxy', {
            addonName: 'kube-proxy',
            resolveConflicts: 'OVERWRITE',
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.28.4-eksbuild.1',
        })
        new eks.CfnAddon(this, 'core-dns', {
            addonName: 'coredns',
            resolveConflicts: 'OVERWRITE',
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.10.1-eksbuild.6',
        })

        new eks.CfnAddon(this, 'aws-ebs-csi-driver', {
            addonName: 'aws-ebs-csi-driver',
            resolveConflicts: 'OVERWRITE',
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.26.0-eksbuild.1',
            serviceAccountRoleArn: new Role(this, 'csi-role', {
                managedPolicies: [ManagedPolicy.fromManagedPolicyArn(this, 'csi-role-policy', 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy')],
                assumedBy: eksOicp
            }).roleArn
        })


        const extDnsNs = 'external-dns'
        const extDnsSA = new eks.ServiceAccount(this, 'external-dns-sa', {
            cluster: this.eksCluster,
            namespace: extDnsNs
        });
        extDnsSA.role.attachInlinePolicy(new Policy(this, 'ext-dns-policy', {
            document: PolicyDocument.fromJson({
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Action": [
                                "route53:ChangeResourceRecordSets"
                            ],
                            "Resource": [
                                "arn:aws:route53:::hostedzone/!*"
                            ]
                        },
                        {
                            "Effect": "Allow",
                            "Action": [
                                "route53:ListHostedZones",
                                "route53:ListResourceRecordSets"
                            ],
                            "Resource": [
                                "*"
                            ]
                        }
                    ]
                }
            )
        }))

        extDnsSA.node.addDependency(this.eksCluster.addManifest('add-external-dns-ns', {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: extDnsNs
            }
        }))

        new eks.HelmChart(this, 'external-dns', {
            cluster: this.eksCluster,
            chart: 'external-dns',
            namespace: extDnsNs,
            repository: 'https://charts.bitnami.com/bitnami',
            version: '6.28.6',
            values: {
                serviceAccount: {
                    create: false,
                    name: extDnsSA.serviceAccountName
                }
            },
        }).node.addDependency(extDnsSA)

        this.argocdRepoName = OdmdNames.create(this);
        this.argocdRepo = new Repository(this, 'argocd-repo', {
            repositoryName: this.argocdRepoName,
            // code: Code.fromDirectory('init-empty-cc-repo', 'dummy')
        })

        this.argoDefHelmOptions = {
            namespace: CurrentEnver.inst.localConfig.argocdNamespace,
            repository: 'https://argoproj.github.io/argo-helm',
            chart: 'argo-cd',
            version: '6.2.3',
            release: CurrentEnver.inst.localConfig.argocdRelease,
            values: {
                repoServer: {
                    serviceAccount: {
                        create: false,
                        name: CurrentEnver.inst.localConfig.argocdRepoSA,
                        annotations: {},
                        labels: {},
                        automountServiceAccountToken: true,
                    }
                }
            }
        } as HelmChartOptions;
        const argoDef = this.eksCluster.addHelmChart('argocd', this.argoDefHelmOptions)

        this.argocdApps = new ArgocdApps(this, 'argocd-apps')
        this.argocdApps.node.addDependency(argoDef, this.argocdRepo)

        new ContractsShareOut(this, new Map<ContractsCrossRefProducer<AnyContractsEnVer>, string>([
            [CurrentEnver.inst.eksCluster.oidcProviderArn, this.eksCluster.openIdConnectProvider.openIdConnectProviderArn],
            [CurrentEnver.inst.eksCluster.clusterEndpoint, this.eksCluster.clusterEndpoint],
            [CurrentEnver.inst.eksCluster.argocdRepoSa, CurrentEnver.inst.localConfig.argocdRepoSA!],
            [CurrentEnver.inst.eksCluster.argocdRepoName, this.argocdRepo.repositoryName],
            [CurrentEnver.inst.eksCluster.clusterIpv4Cidr, vpc.vpcCidrBlock],
            [CurrentEnver.inst.eksCluster.kubectlRoleArn, this.eksCluster.kubectlRole!.roleArn]
        ]))

        const clusterSGs = [
            this.eksCluster.kubectlSecurityGroup,
            this.eksCluster.clusterSecurityGroup,
            this.eksCluster.clusterHandlerSecurityGroup
        ] as ISecurityGroup[]

        new Set<ISecurityGroup>(clusterSGs.filter(s => s != undefined))
            .forEach(sg => {
                ipamWest1Le.cidrs.forEach(cdr => {
                    sg.addIngressRule(Peer.ipv4(cdr), Port.allTraffic())
                })
            })

        const clusterRoles = [
            this.eksCluster.role,
            this.eksCluster.adminRole,
            this.eksCluster.kubectlRole,
            this.eksCluster.kubectlLambdaRole
        ]

        if (this.eksCluster.role) {
            new CfnOutput(this, 'role', {value: this.eksCluster.role.roleArn, exportName: 'rrrole'})
        }

        if (this.eksCluster.adminRole) {
            new CfnOutput(this, 'adminRole', {
                value: this.eksCluster.adminRole.roleArn,
                exportName: 'adminRole'
            })
        }

        if (this.eksCluster.kubectlRole) {
            new CfnOutput(this, 'kubectlRole', {
                value: this.eksCluster.kubectlRole.roleArn,
                exportName: 'kubectlRole'
            })
        }

        if (this.eksCluster.kubectlLambdaRole) {
            new CfnOutput(this, 'kubectlLambdaRole', {
                value: this.eksCluster.kubectlLambdaRole.roleArn,
                exportName: 'kubectlLambdaRole'
            })
        }


        for (let i = 0; i < clusterRoles.length; i++) {
            const r = clusterRoles[i] as Role;
            r.assumeRolePolicy!.addStatements(new PolicyStatement({
                actions: ['sts:AssumeRole'],
                principals: [new ArnPrincipal(`arn:aws:iam::${OndemandContracts.inst.accounts.central}:role/${
                    CurrentEnver.inst.eksCluster.kubeTrustCentralRoleName
                }`)]
            }))
        }
    }

}