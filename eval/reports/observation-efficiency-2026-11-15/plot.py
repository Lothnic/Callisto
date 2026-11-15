"""Regenerate the standalone figure from the saved measurements (matplotlib)."""
from pathlib import Path
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root = Path(__file__).parent
rows = {row['name']: row for row in json.loads((root / 'results.json').read_text())['rows']}
names = ['default_bounded', 'targeted_query', 'full_after', 'change_diff']
labels = ['Default bounded • target omitted', 'Targeted query • target present', 'Full capture • target present', 'Change diff • prior base required']
values = [rows[name]['response_bytes'] for name in names]
fig, ax = plt.subplots(figsize=(10, 4.5), layout='constrained')
ax.barh(labels, values, color=['#7c8994', '#286f67', '#49749b', '#286f67'])
ax.invert_yaxis()
ax.set_xlabel('Serialized tool response bytes (UTF-8; lower is smaller)')
ax.set_title('Zen observations on a 600-item synthetic catalog', loc='left', pad=18)
ax.set_xlim(0, max(values) * 1.2)
for i, value in enumerate(values):
    ax.text(value + max(values) * .02, i, f'{value:,}', va='center')
ax.spines[['top', 'right']].set_visible(False)
fig.savefig(root / 'observation-bytes.png', dpi=160)
