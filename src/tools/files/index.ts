// src/tools/files/index.ts
import { defaultRegistry } from '../registry';
import { globTool } from './glob';
import { readFileTool } from './read-file';
import { writeFileTool } from './write-file';

defaultRegistry.register(globTool);
defaultRegistry.register(readFileTool);
defaultRegistry.register(writeFileTool);

export { globTool, readFileTool, writeFileTool };
