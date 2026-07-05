export type AskUserAnswerCardItem = {
  questionId: string,
  questionLabel: string,
  answerText: string,
  selectedOptionLabels: Array<string>,
  freeText: string | null,
  numericText: string | null,
};

export type AskUserAnswerCardPart = {
  toolCallId: string,
  title: string,
  items: Array<AskUserAnswerCardItem>,
};
