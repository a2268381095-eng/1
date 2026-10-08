import sys, time, numpy as np
sys.path.insert(0, __import__('os').path.dirname(__file__))
from pthload import load_pth

def conv(x, w, b):
    # x: (H,W,Cin) float32, w: (Cout,Cin,3,3)
    H,W_,C=x.shape
    p=np.pad(x,((1,1),(1,1),(0,0)),mode='edge')
    out=np.zeros((H,W_,w.shape[0]),np.float32)
    for ky in range(3):
        for kx in range(3):
            out+= (p[ky:ky+H,kx:kx+W_].reshape(-1,C) @ w[:,:,ky,kx].T).reshape(H,W_,-1)
    return out+b
lrelu=lambda x: np.where(x>0,x,0.2*x)
up2=lambda x: x.repeat(2,0).repeat(2,1)

def rrdbnet(x, sd):
    g=lambda k: (sd[k+'.weight'].astype(np.float32), sd[k+'.bias'].astype(np.float32))
    feat=conv(x,*g('conv_first'))
    h=feat
    nb=len({k.split('.')[1] for k in sd if k.startswith('body.')})
    for i in range(nb):
        inp=h
        for r in (1,2,3):
            pre=f'body.{i}.rdb{r}'
            xs=[h]
            for c in range(1,5):
                xs.append(lrelu(conv(np.concatenate(xs,-1),*g(f'{pre}.conv{c}'))))
            x5=conv(np.concatenate(xs,-1),*g(f'{pre}.conv5'))
            h=x5*0.2+h
        h=h*0.2+inp
    feat=feat+conv(h,*g('conv_body'))
    feat=lrelu(conv(up2(feat),*g('conv_up1')))
    feat=lrelu(conv(up2(feat),*g('conv_up2')))
    return conv(lrelu(conv(feat,*g('conv_hr'))),*g('conv_last'))

def compact(x, sd):
    n=max(int(k.split('.')[1]) for k in sd)
    h=x
    i=0
    while i<=n:
        w=sd[f'body.{i}.weight']
        if w.ndim==4:
            h=conv(h,w.astype(np.float32),sd[f'body.{i}.bias'].astype(np.float32))
        else:
            a=w.astype(np.float32); h=np.where(h>0,h,a*h)
        i+=1
    H,W_,C=h.shape; r=4
    h=h.reshape(H,W_,3,r,r).transpose(0,3,1,4,2).reshape(H*r,W_*r,3)
    return h+x.repeat(4,0).repeat(4,1)

if __name__=='__main__':
    from PIL import Image
    model, src, dst = sys.argv[1:4]
    d=load_pth(model); sd=d.get('params_ema') or d.get('params')
    x=np.asarray(Image.open(src).convert('RGB')).astype(np.float32)/255
    t=time.time()
    y=rrdbnet(x,sd) if 'conv_first.weight' in sd else compact(x,sd)
    print('time',time.time()-t)
    Image.fromarray((np.clip(y,0,1)*255+0.5).astype(np.uint8)).save(dst)
