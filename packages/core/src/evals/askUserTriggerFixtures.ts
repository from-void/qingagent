export type AskUserTriggerDecision = "ask" | "noAsk";

export type AskUserTriggerCategory =
  | "明确写作意图·信息少"
  | "明确写作意图·信息全"
  | "问句/委婉形式写作请求"
  | "明确直接写"
  | "打招呼/身份提问"
  | "知识问答/闲聊"
  | "点评/解释类"
  | "潜在产出未定落稿"
  | "边界难例";

export interface AskUserTriggerFixture {
  id: string;
  category: AskUserTriggerCategory;
  message: string;
  expectedDecision: AskUserTriggerDecision;
  requireWriteDraft?: boolean;
  reason: string;
}

export const askUserTriggerFixtures: AskUserTriggerFixture[] = [
  {
    id: "low-info-article",
    category: "明确写作意图·信息少",
    message: "帮我写篇文章",
    expectedDecision: "ask",
    reason: "首轮明确要生成文章,即使信息少也应先调用 planDraft 确认方向。",
  },
  {
    id: "low-info-report",
    category: "明确写作意图·信息少",
    message: "写个报告吧",
    expectedDecision: "ask",
    reason: "报告是落稿型写作任务,需先确认主题、受众和篇幅。",
  },
  {
    id: "low-info-summary",
    category: "明确写作意图·信息少",
    message: "帮我弄一份总结",
    expectedDecision: "ask",
    reason: "总结属于文档生成,首轮默认先收集方向。",
  },
  {
    id: "low-info-wechat",
    category: "明确写作意图·信息少",
    message: "我要写一篇公众号",
    expectedDecision: "ask",
    reason: "公众号文章是明确写作意图,需先确认主题和风格。",
  },
  {
    id: "low-info-speech",
    category: "明确写作意图·信息少",
    message: "帮我起草个演讲稿",
    expectedDecision: "ask",
    reason: "演讲稿是落稿任务,首轮应先调用 planDraft 确认场景。",
  },
  {
    id: "low-info-xhs",
    category: "明确写作意图·信息少",
    message: "写篇小红书文案",
    expectedDecision: "ask",
    reason: "小红书文案是写作产出,应先确认产品、受众和语气。",
  },
  {
    id: "full-info-industry-report",
    category: "明确写作意图·信息全",
    message: "写一篇3000字行业报告,面向投资人,分五部分,要有数据",
    expectedDecision: "ask",
    reason: "信息较完整但仍是首轮写作任务,产品口径要求确认一次。",
  },
  {
    id: "full-info-new-energy",
    category: "明确写作意图·信息全",
    message: "写一篇新能源车出海分析,2000字,给老板看,结构按背景-机会-风险-建议来",
    expectedDecision: "ask",
    reason: "主题、篇幅、受众、结构齐全时仍需用 planDraft 拍板未定点。",
  },
  {
    id: "full-info-resume",
    category: "明确写作意图·信息全",
    message: "帮我写一份产品经理简历自我评价,150字以内,语气专业一点,突出B端经验",
    expectedDecision: "ask",
    reason: "简历片段是文档写作任务,信息全也先确认。",
  },
  {
    id: "full-info-news-release",
    category: "明确写作意图·信息全",
    message: "写一份新品发布新闻稿,800字,面向科技媒体,标题别太夸张,三段式",
    expectedDecision: "ask",
    reason: "新闻稿写作意图明确,首轮默认先调用 planDraft。",
  },
  {
    id: "full-info-email",
    category: "明确写作意图·信息全",
    message: "写封邮件给客户解释延期,300字左右,语气诚恳,包含补偿方案",
    expectedDecision: "ask",
    reason: "邮件属于写作产出,即使要素充足也先确认方向。",
  },
  {
    id: "full-info-story",
    category: "明确写作意图·信息全",
    message: "写一个短故事,主角是退休老师,1000字,温暖现实主义,结尾要有反转",
    expectedDecision: "ask",
    reason: "故事创作是落稿任务,首轮应确认一次创作取向。",
  },
  {
    id: "question-year-summary",
    category: "问句/委婉形式写作请求",
    message: "能帮我写份年终总结吗?",
    expectedDecision: "ask",
    reason: "问句形式仍是明确写作请求。",
  },
  {
    id: "question-opening-speech",
    category: "问句/委婉形式写作请求",
    message: "可以帮我弄个开业致辞不",
    expectedDecision: "ask",
    reason: "委婉请求要生成致辞,属于写作意图。",
  },
  {
    id: "question-application",
    category: "问句/委婉形式写作请求",
    message: "能不能给我起草一份申请书呀",
    expectedDecision: "ask",
    reason: "申请书是落稿文档,应触发 planDraft。",
  },
  {
    id: "question-promo-copy",
    category: "问句/委婉形式写作请求",
    message: "方便帮我写个活动宣传文案吗",
    expectedDecision: "ask",
    reason: "宣传文案写作请求不能被“提问”豁免。",
  },
  {
    id: "question-review-speech",
    category: "问句/委婉形式写作请求",
    message: "你能帮我准备一段复盘会发言吗",
    expectedDecision: "ask",
    reason: "准备发言稿是明确写作产出。",
  },
  {
    id: "direct-resignation",
    category: "明确直接写",
    message: "帮我写辞职信,直接写别问",
    expectedDecision: "noAsk",
    requireWriteDraft: true,
    reason: "用户明确要求别问,应跳过 planDraft 并直接写稿。",
  },
  {
    id: "direct-now",
    category: "明确直接写",
    message: "写一篇中秋节祝福文案,现在就写",
    expectedDecision: "noAsk",
    requireWriteDraft: true,
    reason: "“现在就写”命中直接写豁免。",
  },
  {
    id: "direct-no-confirm",
    category: "明确直接写",
    message: "给我起草一份会议通知,不要反问,按常规格式来",
    expectedDecision: "noAsk",
    requireWriteDraft: true,
    reason: "明确不要反问,缺失信息应取合理默认并调用 writeDraft。",
  },
  {
    id: "direct-skip-questionnaire",
    category: "明确直接写",
    message: "写个请假条,跳过问卷",
    expectedDecision: "noAsk",
    requireWriteDraft: true,
    reason: "跳过问卷是明确跳过 planDraft 的信号。",
  },
  {
    id: "direct-no-more-questions",
    category: "明确直接写",
    message: "帮我写一篇离职交接说明,别再问了,直接生成",
    expectedDecision: "noAsk",
    requireWriteDraft: true,
    reason: "别再问/直接生成要求直接进入写稿。",
  },
  {
    id: "greeting-hello",
    category: "打招呼/身份提问",
    message: "你好",
    expectedDecision: "noAsk",
    reason: "纯打招呼不属于写作意图。",
  },
  {
    id: "greeting-there",
    category: "打招呼/身份提问",
    message: "在吗",
    expectedDecision: "noAsk",
    reason: "寒暄不应触发 planDraft。",
  },
  {
    id: "identity-who-are-you",
    category: "打招呼/身份提问",
    message: "你是谁?",
    expectedDecision: "noAsk",
    reason: "身份提问正常对话回答即可。",
  },
  {
    id: "identity-what-can-do",
    category: "打招呼/身份提问",
    message: "你能干啥",
    expectedDecision: "noAsk",
    reason: "能力介绍不是落稿写作任务。",
  },
  {
    id: "identity-how-use",
    category: "打招呼/身份提问",
    message: "这个工具怎么用啊",
    expectedDecision: "noAsk",
    reason: "使用咨询不应调用 planDraft。",
  },
  {
    id: "qa-li-bai",
    category: "知识问答/闲聊",
    message: "李白是哪个朝代的",
    expectedDecision: "noAsk",
    reason: "知识问答无落稿意图。",
  },
  {
    id: "qa-weather",
    category: "知识问答/闲聊",
    message: "上海今天会下雨吗",
    expectedDecision: "noAsk",
    reason: "事实查询不是文档写作。",
  },
  {
    id: "chat-bad-mood",
    category: "知识问答/闲聊",
    message: "今天心情不好,陪我聊聊",
    expectedDecision: "noAsk",
    reason: "闲聊陪伴不应触发 planDraft。",
  },
  {
    id: "qa-concept",
    category: "知识问答/闲聊",
    message: "给我解释一下通货膨胀是什么意思",
    expectedDecision: "noAsk",
    reason: "解释概念是问答,不是写入文档。",
  },
  {
    id: "qa-recommend-book",
    category: "知识问答/闲聊",
    message: "最近有什么适合通勤看的书",
    expectedDecision: "noAsk",
    reason: "推荐聊天无落稿要求。",
  },
  {
    id: "review-short-paragraph",
    category: "点评/解释类",
    message: "你觉得这段写得怎么样: 我们将继续努力,把服务做到更好。",
    expectedDecision: "noAsk",
    reason: "用户求点评,未要求生成到右侧文档。",
  },
  {
    id: "review-email-tone",
    category: "点评/解释类",
    message: "帮我看看这封邮件语气是不是太硬",
    expectedDecision: "noAsk",
    reason: "评价语气属于对话建议,不应触发 planDraft。",
  },
  {
    id: "explain-sentence",
    category: "点评/解释类",
    message: "解释一下这句话: 少即是多",
    expectedDecision: "noAsk",
    reason: "解释文本不是写作落稿。",
  },
  {
    id: "review-structure",
    category: "点评/解释类",
    message: "这篇文章结构有什么问题?",
    expectedDecision: "noAsk",
    reason: "结构点评不等于新建或重写文档。",
  },
  {
    id: "latent-slogan",
    category: "潜在产出未定落稿",
    message: "帮我想个口号",
    expectedDecision: "noAsk",
    reason: "短产出但未说明写入文档,不应误触发写作方向工具 planDraft。",
  },
  {
    id: "latent-name",
    category: "潜在产出未定落稿",
    message: "给这个项目取个名字",
    expectedDecision: "noAsk",
    reason: "命名脑暴未定是否落稿,不触发写作方向工具 planDraft。",
  },
  {
    id: "latent-title",
    category: "潜在产出未定落稿",
    message: "想几个标题给我看看",
    expectedDecision: "noAsk",
    reason: "标题候选属于对话式短产出,未要求生成文档。",
  },
  {
    id: "latent-brainstorm-theme",
    category: "潜在产出未定落稿",
    message: "帮我 brainstorm 十个活动主题",
    expectedDecision: "noAsk",
    reason: "创意列表未定落稿,应直接给建议,不调用写作方向工具 planDraft。",
  },
  {
    id: "boundary-character",
    category: "边界难例",
    message: "这个字怎么写: 龘",
    expectedDecision: "noAsk",
    reason: "“写”指汉字写法,不是文档写作。",
  },
  {
    id: "wechat-publish-own-style-route",
    category: "边界难例",
    message: "帮我写一篇发到我公众号的文章，参考我以前的风格",
    expectedDecision: "noAsk",
    reason: "明确要发布到自己的公众号并参考旧文，授权未 READY 时应先单独调用 askUserQuestion 发送公众号路由卡，而不是 planDraft。",
  },
  {
    id: "boundary-poem",
    category: "边界难例",
    message: "写诗",
    expectedDecision: "ask",
    reason: "超短但语义上是诗歌创作请求,应先确认方向。",
  },
  {
    id: "boundary-sql",
    category: "边界难例",
    message: "帮我写个 SQL 查询",
    expectedDecision: "noAsk",
    reason: "代码查询不是产品文档写作意图。",
  },
  {
    id: "boundary-copy-characters",
    category: "边界难例",
    message: "把“尴尬”这俩字写给我看看",
    expectedDecision: "noAsk",
    reason: "只是展示字形/文字,不是生成文档内容。",
  },
];
