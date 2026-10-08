import zipfile, pickle, numpy as np, collections
DT={'FloatStorage':np.float32,'HalfStorage':np.float16,'LongStorage':np.int64,'IntStorage':np.int32}
def load_pth(fn):
    z=zipfile.ZipFile(fn); root=z.namelist()[0].split('/')[0]
    class Storage:
        def __init__(s,name): s.name=name
    def rebuild(storage, offset, size, stride, *a):
        arr=storage
        n=int(np.prod(size)) if size else 1
        flat=arr[offset:offset+ (n if not size else 1+sum((sz-1)*st for sz,st in zip(size,stride)))]
        if not size: return flat.reshape(())
        return np.lib.stride_tricks.as_strided(flat,shape=size,strides=[st*flat.itemsize for st in stride]).copy()
    class U(pickle.Unpickler):
        def find_class(s,mod,name):
            if name=='_rebuild_tensor_v2': return rebuild
            if name=='OrderedDict': return collections.OrderedDict
            if name in DT: return DT[name]
            if mod.startswith('torch'): return lambda *a,**k: None
            return super().find_class(mod,name)
        def persistent_load(s,pid):
            typ,dtype,key,loc,numel=pid
            return np.frombuffer(z.read(f'{root}/data/{key}'),dtype=dtype)
    return U(z.open(f'{root}/data.pkl')).load()
if __name__=='__main__':
    import sys
    d=load_pth(sys.argv[1])
    print(type(d), list(d.keys())[:5])
    sd=d.get('params',d.get('params_ema',d))
    if 'params_ema' in d: sd=d['params_ema']
    for k,v in list(sd.items())[:8]: print(k, v.shape)
    print(len(sd))
