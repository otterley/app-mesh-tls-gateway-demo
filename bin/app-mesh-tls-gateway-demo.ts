#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AppMeshTlsGatewayDemoStack } from '../lib/app-mesh-tls-gateway-demo-stack';

const app = new cdk.App();
new AppMeshTlsGatewayDemoStack(app, 'AppMeshTlsGatewayDemoStack');
