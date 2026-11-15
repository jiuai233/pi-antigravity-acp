"""Read only safe wire metadata and the public ACP result, never auth or model thoughts."""
import collections,json,pathlib
OUT=pathlib.Path(__file__).resolve().parent
flows=collections.defaultdict(dict)
frozen=OUT/'network-events.jsonl'
sources=[frozen]
for file in sources:
    data=file.read_text(encoding='utf8')
    for line in data.splitlines(keepends=True):
        if not line.endswith('\n'):continue
        row=json.loads(line)
        if row.get('flowId'):flows[row['flowId']][row['kind']]=row
requests=[]
for fid,events in flows.items():
    req=events.get('request_summary',{})
    if req.get('coverage')!='google_contents':continue
    identity=events.get('probe_request_identity',{})
    end=events.get('flow_end',{})
    cache=end.get('cacheReadTokens')
    total=end.get('promptTokens')
    requests.append({'flowId':fid,'atUTC8':req.get('atUTC8'),'monotonicNs':req.get('monotonicNs'),
                     'model':req.get('model'),'requestType':req.get('requestType'),
                     'keepaliveOrdinal':identity.get('keepaliveOrdinal'),'keepaliveFields':identity.get('keepaliveFields',{}),
                     'requestIdHasKeepalive':identity.get('requestIdHasKeepalive'),'maxOutputTokens':identity.get('maxOutputTokens'),
                     'fingerprints':req.get('fingerprints',{}),'messageHmacs':req.get('messageHmacs',[]),
                     'status':end.get('status'),'httpStatus':events.get('response_headers',{}).get('status'),
                     'semanticComplete':end.get('semanticComplete'),'sseEvents':end.get('sseEvents'),
                     'usage':end.get('usage',{}),'cacheReadTokens':cache,'cacheReadSource':end.get('cacheReadSource'),
                     'cacheHitRatio':round(cache/total,8) if isinstance(cache,int) and isinstance(total,int) and total else None,
                     'snapshots':events.get('probe_sse_snapshots',{}).get('snapshots',[])})
requests.sort(key=lambda r:r['monotonicNs'] or 0)
main=[r for r in requests if 'hydrogen' in (r['model'] or '')]
pings=[r for r in main if r['requestIdHasKeepalive'] or r['keepaliveFields']]
real=[r for r in main if r not in pings]
probe=json.loads((OUT/'probe-result.json').read_text(encoding='utf8'))
summary={'probeFinished':bool(probe.get('finishedAt')),'probeError':probe.get('error'),
         'realHydrogenRequests':len(real),'identifiedKeepaliveRequests':len(pings),'requests':requests,
         'warmBaselineEstablished':len(real)>1 and (real[1].get('cacheReadTokens') or 0)>0,
         'realRequestPrefixAppend':len(real)==3 and all(a['messageHmacs']==b['messageHmacs'][:len(a['messageHmacs'])] for a,b in zip(real,real[1:])),
         'usageTotals':{key:sum(r['usage'].get(key,0) for r in requests) for key in ['promptTokenCount','cachedContentTokenCount','candidatesTokenCount','thoughtsTokenCount','totalTokenCount']},
         'generationCounts':{key:probe.get(key,{}).get('generationCount') for key in ['WARM2_trajectory','beforePost','afterPost']},
         'stepCounts':{key:probe.get(key,{}).get('stepCount') for key in ['WARM2_trajectory','beforePost','afterPost']},
         'nativeToolNotifications':sum(u['type'].startswith('tool_call') for u in probe.get('nativeUpdates',[])),
         'productionSourceUnchanged':probe.get('productionSourceUnchanged'),
         'productionMonitorConfigUnchanged':probe.get('productionMonitorConfigUnchanged')}
assert summary == json.loads((OUT/'wire-analysis.json').read_text(encoding='utf-8')), 'Frozen analysis mismatch'
print(json.dumps({k:v for k,v in summary.items() if k!='requests'},indent=2))
for r in main:
    print(json.dumps({k:r[k] for k in ['atUTC8','flowId','keepaliveOrdinal','keepaliveFields','maxOutputTokens','status','semanticComplete','usage','cacheReadTokens','cacheHitRatio','sseEvents']},ensure_ascii=False))
