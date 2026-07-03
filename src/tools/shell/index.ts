// src/tools/shell/index.ts
import { defaultRegistry } from '../registry';
import { runCommandTool } from './run-command';

defaultRegistry.register(runCommandTool);

export { runCommandTool };
