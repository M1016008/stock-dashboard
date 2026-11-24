import json, re, os, sys
# Usage: python3 -I closure.py <worktree> <out.json>. Lists the npm scripts and source files reachable from the six weekly steps (and their rollback scripts).
root = sys.argv[1]
pkg = json.load(open(os.path.join(root, 'package.json')))['scripts']
start = ['batch:ml-learning-daily','batch:ml-weekly-governance','batch:us-ml-weekly-efficient','batch:analog-index:jp','batch:analog-index:us','batch:dashboard-cache','db:maintenance:all',
 'batch:ml-candidates','batch:ml-predict','batch:ml-physics-candidates','batch:ml-insights','batch:us-ml-health']
seen_scripts, seen_files = set(), set()
todo = list(start)
import_re = re.compile(r"""from\s+['"](@/[^'"]+|\.{1,2}/[^'"]+)['"]|import\(\s*['"](@/[^'"]+|\.{1,2}/[^'"]+)['"]""")
npm_re = re.compile(r"""(?:runNpm|runNpmScript|npmRun|runScript)\(\s*['"]([a-z0-9:_-]+)['"]|['"](batch:[a-z0-9:_-]+|db:[a-z0-9:_-]+|ml:[a-z0-9:_-]+)['"]""")
def resolve(base, spec):
    if spec.startswith('@/'): p = os.path.join(root, spec[2:])
    else: p = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    for c in [p, p+'.ts', p+'.tsx', p+'.js', os.path.join(p,'index.ts')]:
        if os.path.isfile(c): return c
    return None
ftodo = []
while todo or ftodo:
    while todo:
        s = todo.pop()
        if s in seen_scripts or s not in pkg: continue
        seen_scripts.add(s); cmd = pkg[s]
        for m in re.findall(r'npm run (?:-s )?([a-z0-9:_-]+)', cmd): todo.append(m)
        for m in re.findall(r'(scripts/[A-Za-z0-9_./-]+\.(?:ts|mjs|js|py|sh|zsh))', cmd): ftodo.append(os.path.join(root, m))
    while ftodo:
        f = ftodo.pop()
        if f in seen_files or not os.path.isfile(f): continue
        seen_files.add(f); txt = open(f, encoding='utf8', errors='ignore').read()
        for a,b in import_re.findall(txt):
            r = resolve(f, a or b)
            if r: ftodo.append(r)
        for a,b in npm_re.findall(txt):
            if (a or b) in pkg: todo.append(a or b)
        for m in re.findall(r"""['"`](scripts/[A-Za-z0-9_./-]+\.(?:ts|mjs|js|py|sh))""", txt): ftodo.append(os.path.join(root, m))
print(len(seen_scripts), 'scripts', len(seen_files), 'files')
json.dump({'scripts': sorted(seen_scripts), 'files': sorted(os.path.relpath(f, root) for f in seen_files)}, open(sys.argv[2],'w'), indent=1)
