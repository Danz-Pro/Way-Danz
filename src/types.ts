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

interface QuizQuestionOptionMedia {
  type: string;
  url: string;
  meta?: {
    width: number;
    height: number;
    layout: string;
  };
}

interface QuizQuestionOption {
  id?: string;
  text: string;
  answer?: number;
  type?: string;
  media?: QuizQuestionOptionMedia[];
  matcher?: string;
}

/** BLANK answer format from quiz API: [{targetId, optionId}] */
export interface BlankAnswerItem {
  targetId: string;
  optionId: string[];
}

export interface QuizQuestion {
  _id: string;
  type: string;
  structure: {
    answer: number | number[] | BlankAnswerItem[];
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

/** Quiz API response format: data.quiz.info.questions */
export interface QuizApiResponse {
  success: boolean;
  data: {
    quiz: {
      _id: string;
      info: {
        name: string;
        questions: QuizQuestion[];
      };
    };
    draft?: any;
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
  firstQuestionRetryDelay: number;
  firstQuestionMaxRetries: number;
}
