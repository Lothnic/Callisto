"""Standalone figure from retained summaries; keep suites separate."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
root=Path(__file__).resolve().parents[1]/"reports"
sets=[("Public reads",root/"luna-step5-public-2026-11-17"),("Owned account tasks",root/"luna-step5-account-2026-11-17"),("Official retrieval subset",root/"luna-step5-webarena-2026-11-17")]
colors=["#2563eb","#d97706"]
fig,axes=plt.subplots(3,3,figsize=(12,9),layout="constrained")
for row,(name,path) in enumerate(sets):
 data=json.loads((path/"summary.json").read_text())["all_attempts"]
 for col,(metric,title,unit) in enumerate([("passed","Strict passes",""),("median_seconds","Median task time","seconds"),("uncached_input_tokens","Uncached input per attempt","tokens")]):
  ax=axes[row,col];values=[data[e][metric]/data[e]["attempted"]if metric=="uncached_input_tokens"else data[e][metric]for e in ["zen","browse"]]
  bars=ax.barh([1,0],values,color=colors,height=.53)
  ax.set_yticks([1,0],["Callisto / Zen","Browse / Chromium"]);ax.set_title((name+"\n"if col==0 else "")+title,loc="left",fontsize=11)
  ax.set_xlabel(unit,fontsize=9);ax.spines[["top","right","left"]].set_visible(False);ax.tick_params(axis="y",length=0);ax.grid(axis="x",alpha=.15);ax.set_axisbelow(True)
  if metric=="passed":ax.set_xlim(0,max(data[e]["attempted"]for e in data)*1.25)
  else:ax.set_xlim(0,max(values)*1.3)
  labels=[str(int(v))+"/"+str(data[e]["attempted"])if metric=="passed"else f"{v:,.0f}"if metric=="uncached_input_tokens"else f"{v:.1f}"for e,v in zip(["zen","browse"],values)]
  ax.bar_label(bars,labels=labels,padding=5,fontsize=10)
fig.suptitle("GPT-6 Luna · high effort · pinned Browse 0.1.1",x=.01,ha="left",fontsize=15)
fig.supxlabel("All attempts retained. Different suite interfaces; no pooled score. Public timing includes disclosed preflight overlap.\nSmall task sets; official subset has one attempt per engine/task. Dollar cost and RSS are unmeasured.",fontsize=9)
out=root/"step5-2026-11-17"/"comparison.png";fig.savefig(out,dpi=160);print(out)
