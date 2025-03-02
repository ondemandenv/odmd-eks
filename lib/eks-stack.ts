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
import * as eks from "aws-cdk-lib/aws-eks";
import {Cluster} from "aws-cdk-lib/aws-eks";
import {
    OdmdCrossRefProducer,
    OdmdShareOut,
    OdmdEnverEksCluster
} from "@ondemandenv/contracts-lib-base";
import {KubectlV31Layer} from "@aws-cdk/lambda-layer-kubectl-v31";
import {OndemandContractsSandbox} from "@ondemandenv/odmd-contracts-sandbox";
import {EksClusterEnverSbx} from "@ondemandenv/odmd-contracts-sandbox/lib/repos/_eks/odmd-build-eks-sbx";

export class GyangEksCluster extends Stack {
    public readonly eksCluster: Cluster;

    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const myEnver = OndemandContractsSandbox.inst.getTargetEnver() as EksClusterEnverSbx

        const clusterKmsKey = new Key(this, 'ekskmskey', {
            enableKeyRotation: true,
            alias: this.stackName + '/eks-kms',
        });

        const ipamWest1Le = OndemandContractsSandbox.inst.networking!.ipam_west1_le;
        const ipv4IpamPoolId = myEnver.ipamPoolName.getSharedValue(this)
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
            transitGatewayId: myEnver.transitGatewayShareName.getSharedValue(this)
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

        const gyangAdm = Role.fromRoleName(this, 'gyang-admin', 'AWSReservedSSO_AdministratorAccess_0629d3e576ce725f');

        // const pubIPs = ['67.80.162.234/32']
        const pubIPs = ['67.80.162.234/32', myEnver.natPublicIP.getSharedValue(this) + '/32'];
        this.eksCluster = new eks.Cluster(this, 'gyang-tst-eks-cluster', {
            clusterName: myEnver.clusterName,
            version: eks.KubernetesVersion.V1_31,
            kubectlLayer: new KubectlV31Layer(this, 'kubectl'),
            vpc,
            secretsEncryptionKey: clusterKmsKey,
            placeClusterHandlerInVpc: true,
            // endpointAccess: eks.EndpointAccess.PRIVATE,
            endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...pubIPs),
            // mastersRole: gyangAdm,
            albController: {version: eks.AlbControllerVersion.V2_8_2},
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
            addonVersion: 'v1.19.2-eksbuild.1',
        })
        new eks.CfnAddon(this, 'kube-proxy', {
            addonName: 'kube-proxy',
            resolveConflicts: 'OVERWRITE',
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.31.3-eksbuild.2',
        })
        new eks.CfnAddon(this, 'core-dns', {
            addonName: 'coredns',
            resolveConflicts: 'OVERWRITE',
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.11.4-eksbuild.2',
        })

        new eks.CfnAddon(this, 'aws-ebs-csi-driver', {
            addonName: 'aws-ebs-csi-driver',
            resolveConflicts: 'OVERWRITE',
            clusterName: this.eksCluster.clusterName,
            addonVersion: 'v1.39.0-eksbuild.1',
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

        new OdmdShareOut(this, new Map<OdmdCrossRefProducer<OdmdEnverEksCluster>, string>([
            //oidc Federated Principle, OIDC Issuer, OIDC Provider
            [myEnver.oidcProvider, this.eksCluster.openIdConnectProvider.openIdConnectProviderIssuer],
            [myEnver.clusterEndpoint, this.eksCluster.clusterEndpoint],
            [myEnver.vpcCidr, vpc.vpcCidrBlock],
            [myEnver.kubectlRoleArn, this.eksCluster.kubectlRole!.roleArn],

            //nodes accessing ecr repo
            [myEnver.defaultNodeGroupRoleArn, this.eksCluster.defaultNodegroup!.role.roleArn]
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


        new CfnOutput(this, 'openIdConnectProviderArn', { value: this.eksCluster.openIdConnectProvider.openIdConnectProviderArn})
        new CfnOutput(this, 'openIdConnectProviderIssuer', { value: this.eksCluster.openIdConnectProvider.openIdConnectProviderIssuer})



        for (let i = 0; i < clusterRoles.length; i++) {
            const r = clusterRoles[i] as Role;
            r.assumeRolePolicy!.addStatements(new PolicyStatement({
                actions: ['sts:AssumeRole'],
                principals: [new ArnPrincipal(`arn:aws:iam::${OndemandContractsSandbox.inst.accounts.central}:role/${
                    myEnver.kubeTrustCentralRoleName
                }`)]
            }))
        }
    }

}