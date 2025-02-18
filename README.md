
1. **Main Function (`main.ts`)**:
  - Sets up an AWS CDK application and defines the `buildRegion` and `buildAccount` variables based on environment variables or CodeBuild context.
  - Throws an error if either `buildRegion` or `buildAccount` is not set.
  - Creates a stack configuration with specified account and region.
  - Initializes an `OndemandContractsSandbox` instance and retrieves target environment configurations.
  - Creates an EKS cluster using the `GyangEksCluster` class.
  - Creates a `SimpleK8sManifestStack` for deploying Kubernetes manifests.

2. **EKS Cluster Configuration (`eks-stack.ts`)**:
  - The `GyangEksCluster` class extends `BaseStack` and sets up an EKS cluster with the following configurations:
    - **IAM Roles**: Defines various roles (admin, kubectl, etc.) and their policies.
    - **Security Groups**: Sets up security groups for cluster communication.
    - **VPC Setup**: Creates a VPC with public and private subnets in multiple Availability Zones.
    - **EKS Cluster**: Configures an EKS cluster with networking and encryption settings.
    - **Nodegroup Configuration**: Defines nodegroups with specific instance types, subnet configurations, IAM roles, and scaling policies.
    - **Networking Policies**: Adds policies for pod-to-pod communication within the VPC CIDR range.
  - Outputs ARNs of various roles for external use.

3. **Post-Deployment Configurations**:
  - Sets up permissions for assumed roles from a central account to allow cross-account access.
  - Forwards ports from EC2 instances' interfaces to localhost for local debugging.

4. **Key Outputs**:
  - Exports ARNs of key roles (admin, kubectl, etc.) using CloudFormation outputs.
  - Configures security groups and CIDRs for cluster access from specified IP ranges.