import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChineseMasonry } from './index';

vi.mock('masonic', () => ({
  Masonry: ({ items, render }: any) => (
    <div role="grid">
      {items.map((data: any, index: number) => (
        <div role="gridcell" key={data.article.id}>
          {render({ data, index, width: 290 })}
        </div>
      ))}
    </div>
  ),
}));

describe('ChineseMasonry', () => {
  it('renders an empty state for empty article lists', () => {
    render(<ChineseMasonry items={[]} />);

    expect(screen.getByText('\u6682\u65e0\u6587\u7ae0')).toBeInTheDocument();
  });

  it('renders article cards with the requested template and exact grid width', async () => {
    const { container } = render(
      <ChineseMasonry
        items={[
          {
            id: 'article-1',
            title: 'Test Article',
            description: 'Used to verify that the masonry component renders.',
          },
        ]}
        templateId="curated-taohua-note"
      />,
    );

    expect(await screen.findByText('Test Article')).toBeInTheDocument();
    expect(screen.getByTestId('cm-card')).toHaveAttribute('data-template-id', 'curated-taohua-note');
    expect(container.querySelector('.cm-masonry-grid')).toHaveStyle({ width: '902px' });
  });
});
