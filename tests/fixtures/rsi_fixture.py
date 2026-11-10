#!/usr/bin/env python3
"""Build a real, disposable RSI receipt for the Mesh adapter tests.

This imports the installed RSI scripts read-only and writes only inside the
temporary project passed with --root. It never touches canonical project state.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--skill', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--cwd')
    parser.add_argument('--argv-json')
    parser.add_argument('--extra-code', action='append', default=[])
    args = parser.parse_args()
    skill = pathlib.Path(args.skill).resolve()
    root = pathlib.Path(args.root).resolve()
    route = root / '.research-lifecycle-protocol' / 'routes' / 'A'
    route.mkdir(parents=True, exist_ok=True)
    cwd = pathlib.Path(args.cwd).resolve() if args.cwd else route
    cwd.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(skill / 'scripts'))
    import experiment_execute as ee  # noqa: E402
    import execution_gate as eg  # noqa: E402
    import state_check as sc  # noqa: E402

    state = json.loads((skill / 'examples/preflight-identifiability/ct-mri.json').read_text())['state']
    experiment = state['experiments'][0]
    (cwd / 'train.py').write_text('print("fixture train")\n', encoding='utf-8')
    config = {'execution_design': {key: experiment['execution_protocol'][key] for key in ('arms', 'intervention', 'evaluation')}}
    for name, value in {
        'config.json': config,
        'split.json': {'data_split': experiment['data_split']},
        'prereg.json': experiment['preregistration'],
    }.items():
        (cwd / name).write_text(json.dumps(value), encoding='utf-8')
    manifest = {
        'schema': 'execution-manifest@1',
        'argv': json.loads(args.argv_json) if args.argv_json else ['python3', '-c', 'print("fixture ok")'],
        'cwd': str(cwd),
        'env': {'CUDA_VISIBLE_DEVICES': '0'},
        'requested_hours': 0.05,
        'files': [
            {'kind': 'code', 'path': 'train.py'},
            *({'kind': 'code', 'path': extra} for extra in args.extra_code),
            {'kind': 'config', 'path': 'config.json'},
            {'kind': 'data_split', 'path': 'split.json'},
            {'kind': 'preregistration', 'path': 'prereg.json'},
        ],
        'gpu_devices': ['0'],
    }
    experiment['execution_protocol']['scientific_review']['execution_digest'] = ee.execution_review_digest(
        state, experiment, manifest
    )
    state_path = route / 'research-state.json'
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    scheduler = {
        'state_version': state['state_version'],
        'next_actions': [{'action': 'X1', 'type': 'experiment', 'target': 'C1', 'eig': 'high', 'cost': 'low'}],
        'eig_calibration': {'records': []},
        'operator_stats': {'by_operator': {}, 'recurring_failure_patterns': []},
    }
    scheduler_path = route / 'scheduler.json'
    scheduler_path.write_text(json.dumps(scheduler), encoding='utf-8')
    manifest_path = route / 'rsi-manifest.json'
    manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
    if not sc.check_state(state).ok:
        raise SystemExit('fixture state failed state_check')
    if eg.scheduler_check(state, scheduler)['status'] != 'PASS':
        raise SystemExit('fixture scheduler failed scheduler_check')
    ledger = ee.Ledger(route / '.execution')
    issued = ee.issue(state, 'X1', manifest, ledger, scheduler=scheduler)
    if issued.get('status') not in ('PASS', 'PILOT_ONLY'):
        raise SystemExit('issue did not authorize: ' + json.dumps(issued))
    receipt_path = route / 'receipt.json'
    receipt_path.write_text(json.dumps(issued['receipt'], indent=2) + '\n', encoding='utf-8')
    preview = ee.run(state, 'X1', manifest, issued['receipt'], ledger, execute=False, scheduler=scheduler)
    if preview.get('status') not in ('PASS', 'PILOT_ONLY'):
        raise SystemExit('preview did not authorize: ' + json.dumps(preview))
    result = {
        'state': str(state_path),
        'scheduler': str(scheduler_path),
        'manifest': str(manifest_path),
        'receipt': str(receipt_path),
        'ledger': str(route / '.execution'),
        'experiment': 'X1',
        'stateVersion': str(state['state_version']),
        'preview': preview.get('status'),
        'consumed': None,
    }
    if args.execute:
        executed = ee.run(state, 'X1', manifest, issued['receipt'], ledger, execute=True, scheduler=scheduler)
        result['consumed'] = executed.get('status')
        result['returncode'] = executed.get('returncode')
        if executed.get('status') != 'PASS':
            raise SystemExit('execute did not pass: ' + json.dumps(executed))
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
