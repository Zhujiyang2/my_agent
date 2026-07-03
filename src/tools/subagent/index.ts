// src/tools/subagent/index.ts
import { defaultRegistry } from '../registry';
import { createSpawnAgentTool } from './spawn';
import { createListAgentsTool } from './list';
import { createKillAgentTool, createGetAgentResultTool } from './kill';
import { createCheckMessagesTool, createSendToSubagentTool } from './messages';

defaultRegistry.register(createSpawnAgentTool());
defaultRegistry.register(createListAgentsTool());
defaultRegistry.register(createKillAgentTool());
defaultRegistry.register(createGetAgentResultTool());
defaultRegistry.register(createCheckMessagesTool());
defaultRegistry.register(createSendToSubagentTool());
