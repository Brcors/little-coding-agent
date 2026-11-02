import type { SemanticPlan } from './semantic.js';
export type RequirementIntent = 'bug_fix' | 'feature' | 'tests' | 'refactor' | 'explain' | 'review' | 'other';
export interface ClarificationQuestion { question: string; reason: string; required: boolean; options: string[] }
export interface RequirementSpec {
  title: string;
  intent: RequirementIntent;
  goal: string;
  scope: string[];
  out_of_scope: string[];
  constraints: string[];
  acceptance_criteria: string[];
  assumptions: string[];
  questions: ClarificationQuestion[];
}
export interface ClarificationAnswer { question: string; answer: string; required: boolean }
export interface AnalysisRecord {
  id: string;
  revision: number;
  original_request: string;
  project: string;
  mode: 'openai' | 'rules' | 'demo';
  execution: 'docker' | 'disabled';
  source: 'llm' | 'rules';
  model: string;
  created_at: string;
  updated_at: string;
  status: 'needs_clarification' | 'ready';
  result: Omit<RequirementSpec, 'questions'> & { questions: (ClarificationQuestion & { id: string })[] };
  answers: ClarificationAnswer[];
  refinement_rounds: number;
  usage: { input_tokens: number; output_tokens: number };
  task_id?: string;
  execution_plan?: SemanticPlan;
}
export interface RequirementProvider {
  source: AnalysisRecord['source'];
  model: string;
  analyse(request: string, answers: ClarificationAnswer[], signal: AbortSignal): Promise<{ result: RequirementSpec; usage: AnalysisRecord['usage'] }>;
}
