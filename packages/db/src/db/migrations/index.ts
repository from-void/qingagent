import type { Migration } from "./types.js";
import { migration0001Baseline } from "./0001_baseline.js";
import { migration0002OrphanCleanup } from "./0002_orphan_cleanup.js";
import { migration0003UsageRequestObservability } from "./0003_usage_request_observability.js";
import { migration0004UsageCacheAccountingState } from "./0004_usage_cache_accounting_state.js";
import { migration0005SkillResources } from "./0005_skill_resources.js";
import { migration0006DocumentDerivatives } from "./0006_document_derivatives.js";
import { migration0007StyleTemplates } from "./0007_style_templates.js";
import { migration0008ReviewInstructionAndLexicons } from "./0008_review_instruction_and_lexicons.js";
import { migration0009DeaiStyleTemplates } from "./0009_deai_style_templates.js";
import { migration0010AnnotationGroups } from "./0010_annotation_groups.js";
import { migration0011ReviewTemplates } from "./0011_review_templates.js";
import { migration0012DerivativeWritingTemplates } from "./0012_derivative_writing_templates.js";
import { migration0013ReviewTypesAndSignals } from "./0013_review_types_and_signals.js";
import { migration0014RefreshBuiltinPromptSeeds } from "./0014_refresh_builtin_prompt_seeds.js";
import { migration0015RoleReviewTemplates } from "./0015_role_review_templates.js";
import { migration0016TranslateDerivatives } from "./0016_translate_derivatives.js";
import { migration0017DerivativeCoverTemplate } from "./0017_derivative_cover_template.js";
import { migration0018DocumentOpsMutationScope } from "./0018_document_ops_mutation_scope.js";
import { migration0019LexiconEntryUniqueness } from "./0019_lexicon_entry_uniqueness.js";
import { migration0020DocumentSuggestionIdentityScope } from "./0020_document_suggestion_identity_scope.js";
import { migration0021DeletedSessions } from "./0021_deleted_sessions.js";
import { migration0022DocumentSuggestionBatches } from "./0022_document_suggestion_batches.js";
import { migration0023RestoreQuarantine0002 } from "./0023_restore_quarantine_0002.js";
import { migration0024DocumentRestoreLineageAndOpsIndex } from "./0024_document_restore_lineage_and_ops_index.js";

// 迁移注册表:id 必须从 1 严格连续递增(runner 启动即断言)。
// 新增迁移追加到数组尾部,写确定性 DDL(禁用 baseline 的 catch-正则幂等技),
// 并配 fixture 矩阵测试。历史迁移一经发布不可修改。
export const MIGRATIONS: readonly Migration[] = [
  migration0001Baseline,
  migration0002OrphanCleanup,
  migration0003UsageRequestObservability,
  migration0004UsageCacheAccountingState,
  migration0005SkillResources,
  migration0006DocumentDerivatives,
  migration0007StyleTemplates,
  migration0008ReviewInstructionAndLexicons,
  migration0009DeaiStyleTemplates,
  migration0010AnnotationGroups,
  migration0011ReviewTemplates,
  migration0012DerivativeWritingTemplates,
  migration0013ReviewTypesAndSignals,
  migration0014RefreshBuiltinPromptSeeds,
  migration0015RoleReviewTemplates,
  migration0016TranslateDerivatives,
  migration0017DerivativeCoverTemplate,
  migration0018DocumentOpsMutationScope,
  migration0019LexiconEntryUniqueness,
  migration0020DocumentSuggestionIdentityScope,
  migration0021DeletedSessions,
  migration0022DocumentSuggestionBatches,
  migration0023RestoreQuarantine0002,
  migration0024DocumentRestoreLineageAndOpsIndex,
];
