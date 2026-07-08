import json
import urllib.request
from urllib.parse import urlparse
from pathlib import Path

DATA_URL = "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl"
ANSWERS_URL = "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/reference_answer.json"

def download_file(url: str) -> str:
    print(f"Downloading {url}...")
    with urllib.request.urlopen(url) as response:
        return response.read().decode('utf-8')

def main():
    current_dir = Path(__file__).parent
    subsets_dir = current_dir / "subsets"
    subsets_dir.mkdir(parents=True, exist_ok=True)
    
    # Download raw datasets
    data_content = download_file(DATA_URL)
    answers_content = download_file(ANSWERS_URL)
    
    # Parse reference answers
    answers_data = json.loads(answers_content)
    answers_map = {}
    for web_name, site_data in answers_data.items():
        for ans_entry in site_data.get("answers", []):
            ans_id = ans_entry.get("id")
            ans_val = ans_entry.get("ans")
            if ans_id is not None:
                answers_map[(web_name, int(ans_id))] = ans_val
                
    # Parse tasks
    tasks = []
    lines = data_content.strip().splitlines()
    for line in lines:
        if not line.strip():
            continue
        row = json.loads(line)
        web_name = row["web_name"]
        
        orig_id = row["id"]
        try:
            _, id_num_str = orig_id.split("--")
            id_num = int(id_num_str)
        except Exception:
            id_num = len(tasks)
            
        expected = answers_map.get((web_name, id_num))
        
        # Standardize task_id
        standard_site = web_name.lower().replace(" ", "")
        task_id = f"webvoyager-{standard_site}-{id_num}"
        
        # Extract site domain
        start_url = row["web"]
        try:
            domain = urlparse(start_url).netloc
            if domain.startswith("www."):
                domain = domain[4:]
        except Exception:
            domain = standard_site
            
        task = {
            "id": task_id,
            "benchmark": "webvoyager",
            "site": domain,
            "start_url": start_url,
            "instruction": row["ques"],
            "expected": expected,
            "metadata": {
                "source": "MinorJerry/WebVoyager",
                "scorer": "contains",
                "original_id": orig_id,
                "web_name": web_name
            }
        }
        tasks.append(task)
        
    # Write full.jsonl
    full_path = subsets_dir / "full.jsonl"
    print(f"Writing {len(tasks)} tasks to {full_path}...")
    with open(full_path, "w", encoding="utf-8") as f:
        for t in tasks:
            f.write(json.dumps(t, sort_keys=True) + "\n")
            
    # Sample pr-50 subset
    by_web = {}
    for t in tasks:
        web_name = t["metadata"]["web_name"]
        by_web.setdefault(web_name, []).append(t)
        
    pr_tasks = []
    sorted_web_names = sorted(by_web.keys())
    for idx, web_name in enumerate(sorted_web_names):
        group_tasks = by_web[web_name]
        # Spaced-out sampling to select 3 or 4 tasks per website
        num_to_select = 3 if idx < 10 else 4
        total_group_tasks = len(group_tasks)
        for i in range(num_to_select):
            select_idx = int(i * (total_group_tasks - 1) / (num_to_select - 1)) if num_to_select > 1 else 0
            pr_tasks.append(group_tasks[select_idx])
            
    # Write pr-50.jsonl
    pr_path = subsets_dir / "pr-50.jsonl"
    print(f"Writing {len(pr_tasks)} tasks to {pr_path}...")
    with open(pr_path, "w", encoding="utf-8") as f:
        for t in pr_tasks:
            f.write(json.dumps(t, sort_keys=True) + "\n")
            
    print("Download and packaging complete!")

if __name__ == "__main__":
    main()
