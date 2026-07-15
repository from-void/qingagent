export type RoleAvatarKind =
  | "engineer"
  | "hr"
  | "client"
  | "academic"
  | "editor"
  | "newcomer"
  | "interviewer"
  | "legal"
  | "boss"
  | "investor"
  | "competitor"
  | "beginner"
  | "generic";

export type RoleKeywordSource = "prompt" | "identity" | "genre";

export interface WeightedRoleKeyword {
  term: string;
  weight: number;
  source: RoleKeywordSource;
}

export interface RoleReviewProfile {
  id: string;
  name: string;
  position: string;
  avatar: Exclude<RoleAvatarKind, "generic">;
  keywords: readonly WeightedRoleKeyword[];
}

const words = (
  source: RoleKeywordSource,
  entries: ReadonlyArray<readonly [term: string, weight: number]>,
): WeightedRoleKeyword[] => entries.map(([term, weight]) => ({ term, weight, source }));

/**
 * 固定 ID 同时锚定种子顺序、角色定位、头像与离线评测后的关键词权重。
 * prompt=提示词原词；identity=角色职责词；genre=该角色最常审的文档体裁词。
 */
export const ROLE_REVIEW_PROFILES: readonly RoleReviewProfile[] = [
  {
    id: "review-role-engineer", name: "研发工程师", position: "可行性把关", avatar: "engineer",
    keywords: [
      ...words("prompt", [["可行性", 6], ["边界条件", 6], ["异常分支", 5], ["输入输出", 5], ["性能", 5], ["数据量", 4], ["依赖系统", 4], ["兼容性", 4], ["实现", 3], ["工作量", 3]]),
      ...words("identity", [["技术方案", 6], ["架构", 5], ["接口", 5], ["API", 5], ["并发", 5], ["延迟", 4], ["数据库", 4]]),
      ...words("genre", [["PRD", 5], ["需求文档", 5], ["验收标准", 3]]),
    ],
  },
  {
    id: "review-role-hr", name: "HR招聘官", position: "简历通过率", avatar: "hr",
    keywords: [
      ...words("prompt", [["招聘官", 6], ["经历", 4], ["结果数据", 5], ["沟通能力", 3], ["时间断档", 6], ["职责", 4], ["头衔", 4], ["亮点", 3]]),
      ...words("identity", [["招聘", 6], ["求职", 6], ["候选人", 5], ["岗位", 5], ["任职", 4], ["工作经历", 5], ["项目经历", 4], ["教育经历", 4], ["STAR", 4], ["HR", 5]]),
      ...words("genre", [["简历", 7], ["个人履历", 6], ["求职信", 4]]),
    ],
  },
  {
    id: "review-role-client", name: "甲方客户", position: "凭什么选你", avatar: "client",
    keywords: [
      ...words("prompt", [["甲方", 7], ["范围", 4], ["周期", 4], ["验收标准", 6], ["风险责任", 5], ["承诺", 4], ["案例", 3], ["签约", 6]]),
      ...words("identity", [["客户", 5], ["采购", 6], ["报价", 6], ["交付", 5], ["服务商", 4], ["付款", 4], ["SLA", 4], ["谈判", 4]]),
      ...words("genre", [["解决方案", 6], ["投标", 6], ["招标", 6], ["商务方案", 5]]),
    ],
  },
  {
    id: "review-role-academic", name: "学术评审", position: "严谨性审查", avatar: "academic",
    keywords: [
      ...words("prompt", [["可检验", 6], ["已有工作", 4], ["结论", 3], ["证据", 4], ["样本", 6], ["方法", 5], ["数据来源", 5], ["出处", 3], ["方法局限", 5]]),
      ...words("identity", [["研究", 5], ["实验", 5], ["假设", 5], ["显著性", 6], ["文献", 4], ["引用", 4], ["变量", 4], ["对照组", 4]]),
      ...words("genre", [["论文", 7], ["摘要", 6], ["期刊", 7], ["会议论文", 6]]),
    ],
  },
  {
    id: "review-role-editor", name: "主编把关", position: "发布前终审", avatar: "editor",
    keywords: [
      ...words("prompt", [["主编", 7], ["稿件", 6], ["发布", 5], ["标题", 4], ["标题党", 5], ["读者路径", 5], ["结构", 3], ["跑题", 5], ["注水", 5], ["结尾", 3]]),
      ...words("identity", [["段落", 3], ["终审", 6], ["编辑", 5], ["新闻稿", 4], ["专栏", 4], ["开头", 3]]),
      ...words("genre", [["公众号", 6], ["推文", 5], ["营销文案", 4], ["文章", 2]]),
    ],
  },
  {
    id: "review-role-newcomer", name: "新手同事", position: "交接可读性", avatar: "newcomer",
    keywords: [
      ...words("prompt", [["入职", 7], ["上手", 6], ["前置说明", 5], ["权限", 5], ["内部缩写", 5], ["系统名", 4], ["步骤", 3], ["断层", 4], ["原作者", 3]]),
      ...words("identity", [["新员工", 6], ["交接", 7], ["内部系统", 5], ["操作流程", 4], ["账号", 3], ["FAQ", 4]]),
      ...words("genre", [["SOP", 7], ["操作手册", 6], ["入职指南", 6], ["使用手册", 5], ["教程", 4]]),
    ],
  },
  {
    id: "review-role-interviewer", name: "面试官", position: "深挖追问", avatar: "interviewer",
    keywords: [
      ...words("prompt", [["面试", 7], ["候选人", 5], ["自述", 4], ["追问", 7], ["时间线", 4], ["可信度", 5], ["亲历者", 4]]),
      ...words("identity", [["个人贡献", 6], ["团队贡献", 5], ["面试官", 7], ["技术面", 6], ["行为面试", 6], ["复盘", 3], ["如何验证", 5], ["为什么", 3], ["项目经历", 4]]),
      ...words("genre", [["简历", 3], ["个人陈述", 5], ["面试材料", 6]]),
    ],
  },
  {
    id: "review-custom-legal", name: "法务合规视角", position: "合规红线", avatar: "legal",
    keywords: [
      ...words("prompt", [["广告法", 7], ["绝对化用语", 7], ["夸大", 5], ["承诺", 5], ["保证", 5], ["必然", 5], ["对比贬损", 5], ["认证", 4], ["授权背书", 5], ["唯一", 5], ["永久", 5]]),
      ...words("identity", [["合规", 7], ["法律", 6], ["违约", 6], ["责任", 4], ["保密", 5], ["知识产权", 5], ["许可", 4], ["赔偿", 5]]),
      ...words("genre", [["合同", 7], ["条款", 6], ["营销文案", 5]]),
    ],
  },
  {
    id: "review-custom-boss", name: "老板视角挑刺", position: "总办会预演", avatar: "boss",
    keywords: [
      ...words("prompt", [["总办会", 8], ["结论", 3], ["论据", 4], ["建议", 2], ["谁来做", 5], ["资源", 4], ["目标读者", 3], ["暴露面", 4], ["质询", 5]]),
      ...words("identity", [["老板", 6], ["汇报", 6], ["目标", 4], ["负责人", 5], ["里程碑", 4], ["决策", 5], ["ROI", 6], ["预算", 5], ["行动项", 4], ["OKR", 5]]),
      ...words("genre", [["周报", 7], ["月报", 6], ["季度总结", 5], ["复盘报告", 5]]),
    ],
  },
  {
    id: "review-role-investor", name: "投资人视角", position: "尽调追问", avatar: "investor",
    keywords: [
      ...words("prompt", [["投资", 7], ["尽调", 8], ["增长", 5], ["规模数据", 5], ["商业模式", 6], ["关键假设", 5], ["竞争", 3], ["风险", 3]]),
      ...words("identity", [["融资", 8], ["市场规模", 6], ["毛利", 6], ["CAC", 6], ["LTV", 6], ["估值", 6], ["现金流", 5], ["轮次", 5], ["用户规模", 5], ["获客", 4], ["runway", 6]]),
      ...words("genre", [["BP", 8], ["融资计划书", 8], ["商业计划书", 7]]),
    ],
  },
  {
    id: "review-role-competitor", name: "竞品视角挑刺", position: "对手视角", avatar: "competitor",
    keywords: [
      ...words("prompt", [["竞争对手", 8], ["反驳", 5], ["数据没有出处", 4], ["行业通用能力", 7], ["差异化", 7], ["加固", 3]]),
      ...words("identity", [["竞品", 8], ["对手", 6], ["竞争优势", 6], ["护城河", 6], ["替代方案", 5], ["市占率", 5], ["对比", 4], ["标杆", 4], ["定价", 4], ["弱点", 5], ["竞争格局", 6]]),
      ...words("genre", [["竞品分析", 8], ["功能清单", 5], ["市场分析", 4]]),
    ],
  },
  {
    id: "review-role-beginner", name: "小白读者视角", position: "零基础通读", avatar: "beginner",
    keywords: [
      ...words("prompt", [["普通读者", 7], ["术语", 6], ["没解释", 5], ["逻辑跳跃", 5], ["人话", 6]]),
      ...words("identity", [["读不懂", 6], ["零基础", 8], ["新手", 5], ["入门", 7], ["概念", 4], ["解释", 4], ["类比", 5], ["是什么", 4], ["背景知识", 5], ["阅读门槛", 6], ["晦涩", 5]]),
      ...words("genre", [["科普", 8], ["入门指南", 7], ["知识介绍", 5], ["百科", 5]]),
    ],
  },
];

export const ROLE_REVIEW_PROFILE_BY_ID = new Map(ROLE_REVIEW_PROFILES.map((profile) => [profile.id, profile]));

export function roleReviewProfile(templateId: string): RoleReviewProfile | null {
  return ROLE_REVIEW_PROFILE_BY_ID.get(templateId) ?? null;
}

export function rolePosition(templateId: string): string {
  return roleReviewProfile(templateId)?.position ?? "自定义角色";
}

export function roleAvatarKind(templateId: string): RoleAvatarKind {
  return roleReviewProfile(templateId)?.avatar ?? "generic";
}
