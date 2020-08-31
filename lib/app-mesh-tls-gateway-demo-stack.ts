import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as appmesh from "@aws-cdk/aws-appmesh";
import * as acm from "@aws-cdk/aws-certificatemanager";
import * as iam from "@aws-cdk/aws-iam";
import * as sd from "@aws-cdk/aws-servicediscovery";
import * as lb from "@aws-cdk/aws-elasticloadbalancingv2";

const CertificateAuthorityArn =
  "arn:aws:acm-pca:us-west-2:123456789012:certificate-authority/17c11925-da43-4c9d-a2bd-0b9c7828a9cd";

const PublicCertificateDomainName = "appmeshtlsdemo.example.com";

export class AppMeshTlsGatewayDemoStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc");

    const mesh = new appmesh.Mesh(this, "Mesh");
    const namespace = new sd.HttpNamespace(this, "Namespace", {
      name: "test",
    });
    const sdService = new sd.Service(this, "AppService", {
      namespace,
      name: "app",
    });

    // Certificates
    // App Mesh Gateways and Virtual Nodes can only use PCA or file-backed certificates

    // Gateway
    const gatewayCertificate = new acm.CfnCertificate(
      this,
      "GatewayCertificate",
      {
        domainName: `gateway.${namespace.namespaceName}`,
        certificateAuthorityArn: CertificateAuthorityArn,
      }
    );

    // Service
    const serviceCertificate = new acm.CfnCertificate(
      this,
      "ServiceCertificate",
      {
        domainName: `app.${namespace.namespaceName}`,
        certificateAuthorityArn: CertificateAuthorityArn,
      }
    );

    const vgw = new appmesh.CfnVirtualGateway(this, "Gateway", {
      meshName: mesh.meshName,
      virtualGatewayName: "Gateway",
      spec: {
        backendDefaults: {
          clientPolicy: {
            tls: {
              validation: {
                trust: {
                  acm: {
                    certificateAuthorityArns: [CertificateAuthorityArn],
                  },
                },
              },
            },
          },
        },
        listeners: [
          {
            portMapping: {
              // Can't listen to 443 unless we run as root or add a CAP_NET_BIND_SERVICE capability
              port: 8443,
              protocol: "http",
            },
            tls: {
              mode: "STRICT",
              certificate: {
                acm: {
                  certificateArn: gatewayCertificate.ref,
                },
              },
            },
          },
        ],
      },
    });

    const webAppNode = new appmesh.VirtualNode(this, "WebAppNode", {
      mesh,
      listener: {
        portMapping: {
          port: 80,
          protocol: appmesh.Protocol.HTTP,
        },
      },
      cloudMapService: sdService,
    });
    (webAppNode.node.defaultChild as cdk.CfnResource).addPropertyOverride(
      "Spec.Listeners.0.TLS.Certificate.ACM.CertificateArn",
      serviceCertificate.ref
    );
    (webAppNode.node.defaultChild as cdk.CfnResource).addPropertyOverride(
      "Spec.Listeners.0.TLS.Mode",
      "STRICT"
    );

    const webAppService = new appmesh.VirtualService(this, "WebAppService", {
      mesh,
      virtualNode: webAppNode,
    });

    new appmesh.CfnGatewayRoute(this, "DefaultRoute", {
      gatewayRouteName: "default",
      meshName: mesh.meshName,
      virtualGatewayName: vgw.virtualGatewayName,
      spec: {
        httpRoute: {
          match: {
            prefix: "/",
          },
          action: {
            target: {
              virtualService: {
                virtualServiceName: webAppService.virtualServiceName,
              },
            },
          },
        },
      },
    });

    const bastion = new ec2.BastionHostLinux(this, "Bastion", {
      vpc,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
    });

    const clusterCapacity = cluster.addCapacity("ClusterCapacity", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      minCapacity: 4,
    });
    clusterCapacity.connections.allowFrom(
      bastion.connections,
      ec2.Port.allTraffic()
    );
    clusterCapacity.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    // Gateway task
    const gatewayTaskDefinition = new ecs.Ec2TaskDefinition(
      this,
      "GatewayTaskDefinition",
      {
        networkMode: ecs.NetworkMode.AWS_VPC,
      }
    );
    const gatewayContainer = gatewayTaskDefinition.addContainer("envoy", {
      image: ecs.ContainerImage.fromRegistry(
        `840364872350.dkr.ecr.${this.region}.amazonaws.com/aws-appmesh-envoy:v1.15.0.0-prod`
      ),
      essential: true,
      memoryReservationMiB: 1024,
      cpu: 1024,
      environment: {
        AWS_REGION: this.region,
        APPMESH_VIRTUAL_NODE_NAME: `mesh/${
          mesh.meshName
        }/virtualGateway/${vgw.getAtt("VirtualGatewayName")}`,
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -s http://localhost:9901/server_info | grep state | grep -q LIVE",
        ],
        startPeriod: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3,
      },
      user: "1337",
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "envoy",
      }),
    });
    gatewayContainer.addPortMappings({
      containerPort: 8443,
    });
    gatewayTaskDefinition.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSAppMeshEnvoyAccess")
    );
    // necessary for Envoy to get its own certificate from ACM.
    gatewayTaskDefinition.taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["acm:ExportCertificate"],
        resources: [gatewayCertificate.ref],
      })
    );
    // necessary for Envoy to get CA certificate from ACM-PCA.
    gatewayTaskDefinition.taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["acm-pca:GetCertificateAuthorityCertificate"],
        resources: [CertificateAuthorityArn],
      })
    );
    gatewayTaskDefinition.executionRole?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    const gatewayService = new ecs.Ec2Service(this, "GatewayService", {
      cluster,
      taskDefinition: gatewayTaskDefinition,
      desiredCount: 2,
      placementConstraints: [ecs.PlacementConstraint.distinctInstances()],
    });
    gatewayService.connections.allowFrom(
      bastion.connections,
      ec2.Port.allTraffic()
    );

    // App
    const appTaskDefinition = new ecs.Ec2TaskDefinition(
      this,
      "WebServiceTask",
      {
        networkMode: ecs.NetworkMode.AWS_VPC,
        proxyConfiguration: ecs.ProxyConfigurations.appMeshProxyConfiguration({
          containerName: "envoy",
          properties: {
            appPorts: [80],
            proxyEgressPort: 15001,
            proxyIngressPort: 15000,
            ignoredUID: 1337,
            egressIgnoredIPs: ["169.254.170.2", "169.254.169.254"],
          },
        }),
      }
    );

    const webServiceContainer = appTaskDefinition.addContainer("app", {
      image: new ecs.RepositoryImage("nginx:stable"),
      cpu: 256,
      memoryReservationMiB: 256,
      essential: true,
    });
    webServiceContainer.addPortMappings({
      containerPort: 80,
    });

    const envoyContainer = appTaskDefinition.addContainer("envoy", {
      image: ecs.ContainerImage.fromRegistry(
        `840364872350.dkr.ecr.${this.region}.amazonaws.com/aws-appmesh-envoy:v1.15.0.0-prod`
      ),
      essential: true,
      memoryReservationMiB: 1024,
      cpu: 1024,
      environment: {
        AWS_REGION: this.region,
        APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualNode/${webAppNode.virtualNodeName}`,
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -s http://localhost:9901/server_info | grep state | grep -q LIVE",
        ],
        startPeriod: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3,
      },
      user: "1337",
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "envoy",
      }),
    });
    appTaskDefinition.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSAppMeshEnvoyAccess")
    );
    // necessary for Envoy to get its own certificate from ACM.
    appTaskDefinition.taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["acm:ExportCertificate"],
        resources: [serviceCertificate.ref],
      })
    );
    appTaskDefinition.executionRole?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );
    webServiceContainer.addContainerDependencies({
      container: envoyContainer,
    });

    const webService = new ecs.Ec2Service(this, "WebService", {
      cluster,
      taskDefinition: appTaskDefinition,
      desiredCount: 2,
      vpcSubnets: {
        subnets: vpc.privateSubnets,
      },
    });
    (webService.node.children as cdk.CfnResource[])
      .find((resource) => resource.cfnResourceType === "AWS::ECS::Service")
      ?.addOverride("Properties.ServiceRegistries", [
        {
          RegistryArn: sdService.serviceArn,
        },
      ]);
    webService.connections.allowFrom(
      gatewayService.connections,
      ec2.Port.tcp(80)
    );
    webService.connections.allowFrom(bastion.connections, ec2.Port.tcp(80));

    // Application load balancer
    const lbCertificate = new acm.Certificate(this, "AlbCertificate", {
      domainName: PublicCertificateDomainName,
    });
    const alb = new lb.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
    });
    const albListener = alb.addListener("default", {
      certificates: [lbCertificate],
      protocol: lb.ApplicationProtocol.HTTPS,
    });
    const albTargets = albListener.addTargets("default", {
      protocol: lb.ApplicationProtocol.HTTPS,
      targets: [
        gatewayService.loadBalancerTarget({
          containerName: "envoy",
        }),
      ],
    });
    new cdk.CfnOutput(this, "LoadBalancerHostname", {
      value: alb.loadBalancerDnsName,
    });
  }
}
