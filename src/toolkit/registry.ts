import { z } from 'zod';
import type { Task } from '../types.js';
import { fileTools } from './file-tools.js';
import { editTools } from './edit-tools.js';
import { checkTools } from './check-tools.js';
import { evidenceTools } from './evidence-tools.js';
import type { ToolSpec } from './contracts.js';
export const toolRegistry: readonly ToolSpec[] = [...fileTools, ...editTools, ...checkTools, ...evidenceTools];
const registry = new Map(toolRegistry.map(tool => [tool.name, tool]));
if (registry.size !== toolRegistry.length) throw new Error('Duplicate tool registration');
export const findTool = (name: string) => registry.get(name);
export const allowedTool = (tool: ToolSpec, task: Task) => task.tool_policy === undefined || task.tool_policy === 'workspace' || task.tool_policy === 'read_only' && tool.access === 'read';
export function definitionsFor(task?: Task) {
  return toolRegistry.filter(tool => !task || allowedTool(tool, task)).map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, strict: true, parameters: z.toJSONSchema(tool.schema, { target: 'draft-7' }) }));
}
export const toolCatalogue = () => toolRegistry.map(({ run: _run, schema, ...metadata }) => ({ ...metadata, parameters: z.toJSONSchema(schema, { target: 'draft-7' }) }));
