// src/tools/files/index.ts
import { defaultRegistry } from '../registry';
import { globTool } from './glob';

defaultRegistry.register(globTool);

export { globTool };
