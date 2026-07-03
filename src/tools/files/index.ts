// src/tools/files/index.ts
import { defaultRegistry } from '../registry';
import { globTool } from './glob';
import { readFileTool } from './read-file';

defaultRegistry.register(globTool);
defaultRegistry.register(readFileTool);

export { globTool, readFileTool };
