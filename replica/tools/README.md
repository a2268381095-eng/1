# 清晰版复刻流程

1. 从缩略图裁出角色，按行去掉底部暗角，用背景色盖掉时间水印 → `src_crop.png`
2. 用 Real-ESRGAN 动漫模型放大 4 倍（纯 numpy 推理，不需要 PyTorch）：
   ```
   curl -L -o anime6B.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth
   python3 esrgan.py anime6B.pth src_crop.png up.png
   ```
3. 抠掉橙色背景（边缘反混合去色边）：
   ```
   python3 cutout.py up.png replica_clear.png
   ```
