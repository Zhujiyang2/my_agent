// src/tools/shell/index.ts
import { defaultRegistry } from '../registry';
import { runCommandTool } from './run-command';
import { listTasksTool } from './list-tasks';
import { lookupTaskTool } from './lookup-task';
import { killTaskTool } from './kill-task';
import { cleanupTasksTool } from './cleanup-tasks';

defaultRegistry.register(runCommandTool);
defaultRegistry.register(listTasksTool);
defaultRegistry.register(lookupTaskTool);
defaultRegistry.register(killTaskTool);
defaultRegistry.register(cleanupTasksTool);

export { runCommandTool, listTasksTool, lookupTaskTool, killTaskTool, cleanupTasksTool };
