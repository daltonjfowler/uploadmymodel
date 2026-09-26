# How to print with uploadmymodel

For the classroom LulzBot printers. Takes about 5 minutes once your model is ready.

## 1. Get your model

- **Tinkercad:** Export → **.STL**.
- **Onshape:** right-click the part (or the Part Studio tab) → Export → Format **STL**.
- **Fusion 360:** File → Export → type **STL**. (Or right-click the body → Save As Mesh.)
- **Blender:** File → Export → **STL**. If it opens tiny on the bed, press **Meters (Blender): ×1000**, or export again with **Scale**
  set to **1000** (Blender works in meters).
- Thingiverse: download the **STL**, **OBJ** or **3MF** file.

## 2. Open it

Go to **uploadmymodel.com** and drop the file on the printer bed (or press **Open model**).

- It shows up orange on the bed. The bed is the real size of the printer.
- Too tiny? It may have been made in inches: press **Inches: ×25.4**. From Blender (meters): press
  **Meters (Blender): ×1000**.
- Too big? Press **Shrink to fit**.
- A **holes** flag means the file is damaged. It may print with gaps. Export it again.

## 3. Set it on the bed

- **Move:** drag it. **Turn the view:** drag empty space. **Zoom:** mouse wheel or two fingers.
- **Put a flat side down.** Rotate tool (**R**) → **Lay flat: pick a face** → click the side that
  should touch the bed. Or **Biggest flat side down**.
- **Red means it hangs in the air.** Click **Below** (bottom left) to see underneath. Red parts need
  supports, or turn the model so less is red.
- **Several things in one file?** (Like a set of keychains.) Right-click it → **Split into separate
  objects**. Then you can move and turn each one on its own. Parts that touch stay together.
- Made a mistake? **Ctrl + Z** undoes it.

## 4. Pick your settings

The **class settings** work for most prints. Change something only if you know why.

| Setting | What it does | When to change it |
|---|---|---|
| Print quality | Thin layers look smooth but take longer | **Fast** for rough test parts |
| Infill | How full the inside is | More (30-50%) for parts that get pushed on |
| Tree supports | Branches that hold up red parts | Turn off if nothing is red |
| Adhesion | Skirt (a line around it, the default) or Brim (a flat rim that helps it stick) | Brim for tall, thin or tiny parts. Custom also has Raft (a mat under the whole part) |

Settings with a 🔒 are set by your teacher.

## 5. Slice and save

1. Type your first name. The **File name** fills itself in (your name + the model); change it if
   you like. Keep it short so you can find it on the printer screen.
2. Press **Slice**. The first time, type the **class phrase** from the board. (Slicing only works
   while your teacher has it open; you can set up your model any time.) Supports can take a minute.
3. Look at **Preview**: drag the layer slider to watch your print build up.
4. Press **Save to SD card**. In the window that opens, pick the class SD card and press Save.
   Then **eject the card** before you pull it out.

## 6. Print

Put the card in the printer, pick your file on the screen, and ask your teacher to start it.

**Something wrong?** Read the orange message on the page. It says what to fix. If it still does
not work, ask your teacher.
