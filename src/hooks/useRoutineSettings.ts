import { useMemo } from 'react';
import { useProducts } from '../contexts/ProductContext';
import { parseConcernList } from '../lib/concerns';
import {
  defaultRoutineRules,
  isFallbackOn,
  parseRoutineQuestions,
  parseRoutineRules,
  type RoutineQuestion,
  type RoutineRule,
} from '../lib/routine';

export interface RoutineSettings {
  rules: RoutineRule[];
  fallback: boolean;
  questions: RoutineQuestion[];
  concernList: string[];
}

/** Batch 72: the concern list and "Complete your routine" settings. A rule
 *  list that was never saved starts from the default rules. */
export function useRoutineSettings(): RoutineSettings {
  const { settings, categories } = useProducts();
  const { routine_rules, routine_fallback, routine_questions, concern_list } = settings;
  return useMemo(
    () => ({
      rules:
        routine_rules === null || routine_rules === undefined || routine_rules === ''
          ? defaultRoutineRules(categories)
          : parseRoutineRules(routine_rules),
      fallback: isFallbackOn(routine_fallback),
      questions: parseRoutineQuestions(routine_questions),
      concernList: parseConcernList(concern_list),
    }),
    [routine_rules, routine_fallback, routine_questions, concern_list, categories]
  );
}
