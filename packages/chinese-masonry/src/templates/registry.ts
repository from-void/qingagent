import { defaultTemplates } from './defaults';
import type { TemplateDefinition } from './types';

type LazyLoader = () => Promise<TemplateDefinition>;

export class TemplateRegistry {
  private templates = new Map<string, TemplateDefinition>();
  private lazyLoaders = new Map<string, LazyLoader>();
  private loading = new Map<string, Promise<TemplateDefinition>>();

  constructor(initialTemplates: TemplateDefinition[] = []) {
    initialTemplates.forEach((template) => this.register(template));
  }

  register(template: TemplateDefinition): void {
    this.templates.set(template.id, template);
    this.lazyLoaders.delete(template.id);
    this.loading.delete(template.id);
  }

  registerLazy(id: string, loader: LazyLoader): void {
    if (!this.templates.has(id)) {
      this.lazyLoaders.set(id, loader);
    }
  }

  get(id: string): TemplateDefinition | undefined {
    return this.templates.get(id);
  }

  async load(id: string): Promise<TemplateDefinition> {
    const existing = this.templates.get(id);
    if (existing) return existing;

    const current = this.loading.get(id);
    if (current) return current;

    const loader = this.lazyLoaders.get(id);
    if (!loader) {
      throw new Error(`Template "${id}" is not registered.`);
    }

    const promise = loader().then((template) => {
      this.register(template);
      return template;
    });
    this.loading.set(id, promise);
    return promise;
  }

  getAll(): TemplateDefinition[] {
    return Array.from(this.templates.values());
  }

  getByCategory(category: string): TemplateDefinition[] {
    return this.getAll().filter((template) => template.meta.category === category);
  }

  remove(id: string): boolean {
    this.lazyLoaders.delete(id);
    this.loading.delete(id);
    return this.templates.delete(id);
  }
}

export function createDefaultRegistry(): TemplateRegistry {
  return new TemplateRegistry(defaultTemplates);
}
