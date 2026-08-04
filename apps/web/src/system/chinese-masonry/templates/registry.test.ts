import { describe, expect, it } from 'vitest';
import { defaultTemplates } from './defaults';
import { TemplateRegistry } from './registry';

describe('TemplateRegistry', () => {
  it('registers, queries and removes templates by id and category', () => {
    const registry = new TemplateRegistry();
    const template = defaultTemplates[0]!;

    registry.register(template);

    expect(registry.get(template.id)).toEqual(template);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getByCategory(template.meta.category)).toEqual([template]);
    expect(registry.remove(template.id)).toBe(true);
    expect(registry.get(template.id)).toBeUndefined();
  });

  it('loads lazy templates on demand once', async () => {
    const registry = new TemplateRegistry();
    let calls = 0;

    registry.registerLazy('lazy-template', async () => {
      calls += 1;
      return defaultTemplates[0]!;
    });

    const first = await registry.load('lazy-template');
    const second = await registry.load('lazy-template');

    expect(first.id).toBe(defaultTemplates[0]!.id);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('懒加载失败后允许再次尝试', async () => {
    const registry = new TemplateRegistry();
    let calls = 0;

    registry.registerLazy('retryable-template', async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return defaultTemplates[0]!;
    });

    await expect(registry.load('retryable-template')).rejects.toThrow('temporary failure');
    await expect(registry.load('retryable-template')).resolves.toEqual(defaultTemplates[0]);
    expect(calls).toBe(2);
  });
});
