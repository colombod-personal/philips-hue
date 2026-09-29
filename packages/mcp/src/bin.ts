#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHueMcpServer } from './server.js';

const { server, close } = createHueMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
const shutdown = () => {
  close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
