# App Mesh TLS Gateway Demo

This is CDK application that creates a demo container application (nginx) on
Amazon ECS. The application is part of an AWS App Mesh and is fronted by an App
Mesh Virtual Gateway. The stack has encryption in transit via TLS throughout.

## Architecture

Traffic is directed at an AWS Application Load Balancer. The targets of the ALB
are a pair of ECS tasks operating as a Virtual Gateway. This Virtual Gateway
routes all its traffic to a Virtual Node that corresponds to the appplication.

All certificates are provisioned through Amazon Certificate Manager (ACM). The
load balancer certificate is a public certificate. All other certificates
(gateway and virtual node) are provisioned by ACM Private Certificate Authority.

## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
