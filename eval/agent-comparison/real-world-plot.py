"""Plot saved public-site agent trials. Run with uv run --with matplotlib."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

root = Path(sys.argv[1])
data = json.loads((root / ('results-reviewed.json' if (root / 'results-reviewed.json').exists() else 'results.json')).read_text())
rows = data['results']
if not rows:
    raise SystemExit('No measured trials to plot')
engines = ('zen', 'browse')
labels = {'zen': 'Callisto / Zen', 'browse': 'browse / Chromium'}
colours = {'zen': '#2563eb', 'browse': '#c56b08'}
task_names = {task['id']: task['name'] for task in data['tasks']}
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False,
                     'axes.spines.right': False, 'axes.spines.left': False, 'axes.edgecolor': '#b9c1cb',
                     'text.color': '#15202b', 'axes.labelcolor': '#334155', 'xtick.color': '#475569',
                     'ytick.color': '#334155', 'figure.facecolor': 'white', 'axes.facecolor': 'white'})
fig, axes = plt.subplots(3, 1, figsize=(8.2, 8.9), gridspec_kw={'height_ratios': [1.1, 3.6, 1.25]})
fig.subplots_adjust(top=.86, bottom=.14, left=.25, right=.94, hspace=.75)
fig.suptitle('Public-site tasks through the same agent host', x=.03, y=.985, ha='left', fontsize=16, fontweight='bold')
fig.text(.03, .95, f"{data['model']} · {data['reasoning_effort']} effort · {len(data['tasks'])} tasks × {data['repetitions']} repetitions per browser", fontsize=9, color='#475569')

ax = axes[0]
for index, engine in enumerate(engines):
    trials = [row for row in rows if row['engine'] == engine]
    good = sum(row['success'] is True for row in trials)
    ax.barh(index, 100 * good / len(trials), color=colours[engine], height=.48)
    ax.text(min(100 * good / len(trials) + 2, 102), index, f'{good}/{len(trials)}', va='center', fontsize=10)
ax.set_yticks([0, 1], [labels[engine] for engine in engines]); ax.invert_yaxis()
ax.set_xlim(0, 115); ax.set_xticks([0, 25, 50, 75, 100]); ax.set_xlabel('Successful trials (%)')
ax.set_title('Completion, with failed attempts retained', loc='left', fontsize=11, pad=14)
ax.tick_params(axis='y', length=0); ax.grid(axis='x', alpha=.15); ax.set_axisbelow(True)

ax = axes[1]
for index, task in enumerate(data['tasks']):
    for engine in engines:
        trials = [row for row in rows if row['engine'] == engine and row['task'] == task['id']]
        offset = -.12 if engine == 'zen' else .12
        for repeat, row in enumerate(trials):
            y = index + offset + (repeat - (len(trials)-1)/2)*.055
            ax.scatter(row['task_elapsed_ms']/1000, y, c=colours[engine], s=42,
                       marker=('s' if row.get('phase', 0)>0 else 'o') if row['success'] is True else 'x', zorder=3)
ax.set_yticks(range(len(data['tasks'])), [task_names[task['id']] for task in data['tasks']]); ax.invert_yaxis()
ax.set_xlim(left=0)
ax.set_xlabel('End-to-end task time (seconds), including retries and verification')
ax.set_title('Each attempt · circles/squares passed, crosses did not pass', loc='left', fontsize=11, pad=14)
ax.tick_params(axis='y', length=0); ax.grid(axis='x', alpha=.15); ax.set_axisbelow(True)
ax.legend(handles=[Line2D([0], [0], color=colours[e], marker='o', linestyle='None', label=labels[e]) for e in engines],
          frameon=False, loc='upper right', fontsize=9)

ax = axes[2]
for index, engine in enumerate(engines):
    trials = [row for row in rows if row['engine'] == engine]
    uncached = sum((row.get('usage') or {}).get('input_tokens', 0) - (row.get('usage') or {}).get('cached_input_tokens', 0) for row in trials)
    ax.barh(index, uncached/1000, color=colours[engine], height=.48)
    ax.text(uncached/1000, index, f'  {uncached:,}', va='center', fontsize=9)
ax.set_yticks([0, 1], [labels[e] for e in engines]); ax.invert_yaxis()
ax.set_xlim(0, ax.get_xlim()[1]*1.25); ax.set_xlabel('Reported uncached model input tokens (thousands)')
ax.set_title('New model input across all attempts', loc='left', fontsize=11, pad=14)
ax.tick_params(axis='y', length=0); ax.grid(axis='x', alpha=.15); ax.set_axisbelow(True)
fig.text(.03, .025, 'Source: saved native MCP traces and Codex CLI usage · '+data['metadata']['started_at'][:10]+'\nCircles: initial profiles. Squares: resumed profiles. Cached/output tokens are in the report. Dollar charges unavailable.',
         fontsize=8, color='#475569', va='bottom')
fig.savefig(root/'comparison.png', dpi=180)
fig.savefig(root/'comparison.svg')
svg_path = root / 'comparison.svg'
svg_path.write_text('\n'.join(line.rstrip() for line in svg_path.read_text().splitlines()) + '\n')
print(root/'comparison.png')
