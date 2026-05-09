/*
Way-Danz
Optimized Wayground Cheat Engine
https://github.com/Danz-Pro/Way-Danz
*/

export interface Vue3Element extends HTMLElement {
  __vue_app__: any;
  __vueParentComponent?: any;
}

export interface Vue2Element extends HTMLElement {
  __vue__: any;
}

interface QuizQuestionOption {
  text: string;
  answer?: number;
  type?: string;
}

export interface QuizQuestion {
  _id: string;
  type: string;
  structure: {
    answer: number | number[];
    options?: QuizQuestionOption[];
    query?: {
      text: string;
      answer: number;
      media?: any[];
      hasMath?: boolean;
    };
  };
}

export interface QuizInfo {
  data: {
    questions: QuizQuestion[];
  };
}

export interface CheatConfig {
  pollInterval: number;
  highlightColor: string;
  dimOpacity: string;
  autoAnswer: boolean;
  showPanel: boolean;
  debugMode: boolean;
  retryAttempts: number;
  retryDelay: number;
  mutationDebounce: number;
}
