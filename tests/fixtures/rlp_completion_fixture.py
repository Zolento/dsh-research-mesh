#!/usr/bin/env python3
"""Build a real terminal RLP state and (optionally) a real Assurance file.

Uses the RLP skill's own fixture/apply/assurance-store entry points; it never
fabricates an analysis or a review by hand.
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
    parser.add_argument('--mode', choices=['pass', 'needs_review', 'fail', 'stale'], required=True)
    args = parser.parse_args()

    skill = pathlib.Path(args.skill).resolve()
    root = pathlib.Path(args.root).resolve()
    sys.path.insert(0, str(skill / 'scripts'))
    import evidence_outcome as eo  # noqa: E402
    import test_evidence_outcome as tf  # noqa: E402

    route = root / '.research-lifecycle-protocol' / 'routes' / 'A'
    route.mkdir(parents=True, exist_ok=True)
    applied = eo.apply(*tf.fixture('positive'), timestamp=tf.TIMESTAMP)
    if applied.get('status') != 'PASS':
        raise SystemExit('apply did not pass: ' + json.dumps(applied)[:800])
    state = applied['state']
    xid = 'X1'
    state_path = route / 'research-state.json'
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    assurance = None
    if args.mode in ('pass', 'fail', 'stale'):
        checks = {
            name: {'status': 'PASS', 'reason': f'{name} verified against the committed analysis'}
            for name in eo.ASSURANCE_CHECKS
        }
        stored = eo.store_assurance(state, xid, checks, 'R10', route_dir=route)
        if stored.get('status') != 'PASS':
            raise SystemExit('assurance-store failed: ' + json.dumps(stored)[:800])
        assurance_path = pathlib.Path(stored['path'])
        if args.mode == 'fail':
            payload = json.loads(assurance_path.read_text(encoding='utf-8'))
            payload['checks']['integrity'] = {'status': 'FAIL', 'reason': 'integrity review rejected the run'}
            assurance_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if args.mode == 'stale':
            state['state_version'] = state['state_version'] + 1
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        assurance = str(assurance_path)

    print(json.dumps({
        'state': str(state_path),
        'assurance': assurance,
        'experiment': xid,
        'mode': args.mode,
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
