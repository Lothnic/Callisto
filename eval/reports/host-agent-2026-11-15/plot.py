"""Render the retained one-trial host measurements; requires matplotlib."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root = Path(__file__).parent
report = json.loads((root / 'results.json').read_text())
tasks = [task['id'] for task in report['tasks']]
rows = {(row['engine'], row['task']): row for row in report['results']}
fig, axes = plt.subplots(1, 2, figsize=(11, 5.8))
for engine, label, color, offset in [('zen', 'Callisto / Zen', '#286f67', -.18), ('browse', 'browse / Chromium', '#49749b', .18)]:
    group = [rows[engine, task] for task in tasks]
    for ax, values in zip(axes, [[r['elapsed_ms'] / 1000 for r in group], [(r['usage']['input_tokens'] + r['usage']['output_tokens']) / 1000 for r in group]]):
        ax.barh([i + offset for i in range(len(tasks))], values, height=.32, label=label, color=color)
for ax, title in zip(axes, ['Elapsed seconds — host startup included', 'Host input + output tokens (thousands)']):
    ax.set_yticks(range(len(tasks)), ['Form', 'Paginated table', 'Frame + shadow', 'Inventory'])
    ax.invert_yaxis()
    ax.set_xlabel(title)
    ax.spines[['top', 'right']].set_visible(False)
fig.subplots_adjust(top=.80, bottom=.20, left=.15, right=.98, wspace=.50)
fig.legend(*axes[0].get_legend_handles_labels(), loc='upper center', bbox_to_anchor=(.5, .92), ncol=2)
fig.suptitle('Codex host with native MCP tools • one paired trial • all tasks passed', fontsize=13)
fig.supxlabel('Cached input is included. Zen ran first in each pair. No billed dollar cost was supplied.', fontsize=10)
fig.savefig(root / 'host-pilot.png', dpi=160)
