import numpy as np, cv2, sys
from PIL import Image
S='/tmp/claude-0/-home-user-1/300537a6-008c-5f6f-aa2c-e3bd6a09739d/scratchpad'
im=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
border=np.concatenate([im[:8].reshape(-1,3),im[:, :8].reshape(-1,3),im[:, -8:].reshape(-1,3)])
bg=np.median(border,0)
dist=np.sqrt(((im-bg)**2).sum(-1))
near=(dist<40).astype(np.uint8)
n,lab,stats,_=cv2.connectedComponentsWithStats(near,connectivity=4)
edge_labels=set(np.unique(np.concatenate([lab[0],lab[-1],lab[:,0],lab[:,-1]])))-{0}
keep=[i for i in range(1,n) if i in edge_labels or stats[i,cv2.CC_STAT_AREA]>80]
bgmask=np.isin(lab,keep)
alpha=np.where(bgmask,0.0,1.0)
ring=(cv2.dilate(bgmask.astype(np.uint8),np.ones((5,5),np.uint8))>0)&~bgmask
alpha[ring]=np.clip((dist[ring]-25)/90,0,1)
alpha=cv2.GaussianBlur(alpha.astype(np.float32),(3,3),0.6)
alpha[~ring&~bgmask]=1
alpha[cv2.erode(bgmask.astype(np.uint8),np.ones((3,3),np.uint8))>0]=0
a=np.clip(alpha,1e-3,1)[...,None]
fg=np.clip((im-(1-a)*bg)/a,0,255)
fg=np.where(alpha[...,None]>0.02,fg,0)
img=Image.fromarray(np.dstack([fg,alpha*255]).astype(np.uint8),'RGBA')
bb=img.getbbox(); img=img.crop((bb[0]-8,bb[1]-8,bb[2]+8,bb[3]+8))
img.save(sys.argv[2])
for name,col in (('white',(255,255,255)),('dark',(40,36,52))):
    b=Image.new('RGBA',img.size,col+(255,)); b.alpha_composite(img); b.save(sys.argv[2].replace('.png',f'_{name}.png'))
print(img.size)
