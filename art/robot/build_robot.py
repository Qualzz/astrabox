"""Native authored profiles and articulated assembly. Run with Blender --background.

No Meshy geometry is imported into the resulting model. The reference is used
for dimensions/proportions; all surfaces below are constructed piece by piece.
"""
import bpy
import math
import json
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art/robot'
QA = ROOT / 'output/robot-authored'
QA.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def material(name, color, roughness, metallic=0, coat=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Coat Weight'].default_value = coat
    shader.inputs['Coat Roughness'].default_value = .25
    if emission:
        shader.inputs['Emission Color'].default_value = (*color, 1)
        shader.inputs['Emission Strength'].default_value = emission
    mat.diffuse_color = (*color, 1)
    return mat

blue = material('Satin blue enamel', (.055, .19, .60), .36, .10, .10)
blue_edge = material('Blue recessed seams', (.015, .073, .17), .45, .12)
rubber = material('Soft graphite rubber', (.023, .026, .031), .48)
joint = material('Dark bearing metal', (.075, .086, .10), .33, .65)
glass = material('TV glass — runtime replaces display', (.003, .009, .017), .28)
cream = material('Warm status lamp', (1, .65, .32), .38, emission=.25)

def group(name, parent=None, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    obj.empty_display_type = 'PLAIN_AXES'
    obj.empty_display_size = .075
    return obj

def mesh(name, vertices, faces, mat, parent=None):
    data = bpy.data.meshes.new(name + '-topology')
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.parent = parent
    data.materials.append(mat)
    for face in data.polygons:
        face.use_smooth = True
    obj['part_id'] = name
    return obj

def rounded_loop(width, height, radius, steps=10):
    """CCW rounded rectangle, stable correspondence across every profile loop."""
    result = []
    for cx, cy, angle in [(width/2-radius, height/2-radius, 0),
                          (-width/2+radius, height/2-radius, math.pi/2),
                          (-width/2+radius, -height/2+radius, math.pi),
                          (width/2-radius, -height/2+radius, math.pi*1.5)]:
        for i in range(steps+1):
            a = angle + math.pi/2 * i/steps
            result.append((cx + radius*math.cos(a), cy + radius*math.sin(a)))
    return result

def loft(name, profiles, mat, parent=None, axis='y', center=(0, 0, 0), caps=(False, False), steps=10):
    vertices, faces = [], []
    n = 4 * (steps + 1)
    for depth, width, height, radius in profiles:
        for u, v in rounded_loop(width, height, radius, steps):
            p = (u, depth, v) if axis == 'y' else (u, v, depth)
            vertices.append(tuple(p[i]+center[i] for i in range(3)))
    for ring in range(len(profiles)-1):
        for j in range(n):
            faces.append((ring*n+j, ring*n+(j+1)%n, (ring+1)*n+(j+1)%n, (ring+1)*n+j))
    if caps[0]: faces.append(tuple(reversed(range(n))))
    if caps[1]: faces.append(tuple((len(profiles)-1)*n+j for j in range(n)))
    obj = mesh(name, vertices, faces, mat, parent)
    # Recalculate outward normals rather than relying on the loft axis winding.
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode='OBJECT')
    return obj

def lathe(name, profile, mat, parent=None, segments=48, axis='x'):
    vertices, faces = [], []
    for depth, radius in profile:
        for j in range(segments):
            a = j * math.tau / segments
            p = (depth, radius*math.cos(a), radius*math.sin(a)) if axis == 'x' else (radius*math.cos(a), radius*math.sin(a), depth)
            vertices.append(p)
    for i in range(len(profile)-1):
        for j in range(segments):
            faces.append((i*segments+j, i*segments+(j+1)%segments, (i+1)*segments+(j+1)%segments, (i+1)*segments+j))
    faces.extend([tuple(reversed(range(segments))), tuple((len(profile)-1)*segments+j for j in range(segments))])
    obj = mesh(name, vertices, faces, mat, parent)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode='OBJECT')
    return obj

root = group('robot-root')
root['model_version'] = 2
root['construction'] = 'Authored Blender profiles; separate head and four steering/rolling wheels'
root['collider'] = json.dumps({'type':'compound','chassis':[1.3,1.22,.51],'head':[1.537,.71,1.25]})

# Chassis is a rounded rectangular shell with deliberately placed vertical loops.
chassis = loft('chassis-shell', [
    (-.866,1.09,1.02,.20),(-.853,1.20,1.10,.22),(-.814,1.28,1.17,.24),
    (-.77,1.30,1.20,.25),(-.56,1.31,1.22,.26),(-.49,1.28,1.20,.26),
    (-.428,1.20,1.12,.25),(-.398,1.08,1.02,.24),(-.393,1.05,.99,.23),
], blue, root, axis='z', caps=(True,True))
# A shallow parting line, not a painted line crossing an unrelated wheel mesh.
seam = loft('chassis-lower-seam', [(-.766,1.301,1.201,.251),(-.761,1.302,1.202,.251)], blue_edge, root, axis='z')
seam['explodeWithParent'] = True
top = loft('chassis-top-cover', [(-.394,1.03,.97,.22),(-.383,1.00,.94,.215)], blue, root, axis='z', caps=(False,True))
top['explodeWithParent'] = True

# Recessed lamps on both observed chassis faces, each inset into its bezel.
for end, y in [('front',-.608),('rear',.608)]:
    assembly = group('status-'+end, root, (0,y,-.646))
    if end == 'rear': assembly.rotation_euler.z = math.pi
    loft('lamp-bezel-'+end, [(0,.295,.078,.023),(-.009,.284,.068,.02)], joint, assembly, caps=(False,True), steps=5)
    loft('lamp-lens-'+end, [(-.011,.255,.049,.014),(-.015,.247,.043,.012)], cream, assembly, caps=(False,True), steps=5)

# Rotating neck is socketed into the cover; pitch is above the bearing.
lathe('neck-bearing', [(-.398,.23),(-.38,.236),(-.353,.218)], joint, root, axis='z')
yaw = group('head-yaw', root, (0,0,-.36))
lathe('neck-spindle', [(-.01,.16),(.105,.16)], blue, yaw, axis='z')
pitch = group('head-pitch', yaw)
pitch.rotation_euler.x = -.2037
head_center = (0,-.09,.637)
# Rear-to-front continuous shell, with an open front ending at the glass lip.
head = loft('head-shell', [
    (.344,1.365,1.08,.16),(.338,1.432,1.16,.20),(.31,1.502,1.215,.225),
    (.263,1.537,1.251,.235),(.19,1.537,1.251,.235),(-.225,1.537,1.251,.235),
    (-.289,1.525,1.24,.225),(-.337,1.48,1.20,.205),(-.361,1.405,1.137,.175),
    (-.362,1.325,1.057,.13),(-.346,1.30,1.032,.12),
], blue, pitch, center=head_center, caps=(True,False))
rear_line = loft('head-rear-seam', [(.191,1.538,1.252,.236),(.195,1.538,1.252,.236)], blue_edge, pitch, center=head_center)
rear_line['explodeWithParent'] = True
gasket = loft('display-gasket', [(-.344,1.301,1.033,.12),(-.339,1.289,1.021,.117)], rubber, pitch, center=head_center)
gasket['explodeWithParent'] = True
display_vertices=[(x+head_center[0], -.338+head_center[1], z+head_center[2]) for x,z in rounded_loop(1.29,1.022,.117,12)]
display=mesh('robot-screen',display_vertices,[tuple(range(len(display_vertices)))],glass,pitch)
uv=display.data.uv_layers.new(name='Display UV')
for loop in display.data.loops:
    p=display.data.vertices[loop.vertex_index].co
    uv.data[loop.index].uv=((p.x-head_center[0])/1.29+.5,(p.z-head_center[2])/1.022+.5)
display['arcade_screen']=True;display['aspect']=1.29/1.022

# Every wheel has two independent mechanical axes: steer Z, then roll X.
tire_profile=[(-.093,.115),(-.091,.17),(-.080,.197),(-.06,.213),(-.025,.216),
              (-.024,.213),(-.021,.213),(-.020,.216),(.035,.216),(.036,.213),
              (.039,.213),(.040,.216),(.073,.206),(.091,.177),(.096,.12)]
for label,x,y in [('fl',-.635,-.395),('fr',.635,-.395),('rl',-.635,.395),('rr',.635,.395)]:
    socket=group('wheel-socket-'+label,root,(x,y,-.741))
    steer=group('wheel-steer-'+label,socket)
    spin=group('wheel-spin-'+label,steer)
    lathe('tire-'+label,tire_profile,rubber,spin)
    side=1 if x>0 else -1
    hub=lathe('hub-'+label,[(side*.095,.093),(side*.104,.105),(side*.115,.096)],blue,spin)
    hub['explodeWithParent']=True
    axle=lathe('axle-'+label,[(-.08,.055),(.08,.055)],joint,socket,segments=24)
    # Shallow, authored wheel arches make space for steering, not an opaque
    # chassis intersecting the entire tire. Apply a bounded boolean per corner.
    bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.231,depth=.28,location=(side*.691,y,-.741),rotation=(0,math.pi/2,0))
    cutter=bpy.context.object;cutter.name='temporary-wheel-clearance-'+label
    for shell in [chassis,seam]:
        bpy.context.view_layer.objects.active=shell
        mod=shell.modifiers.new('Wheel arch '+label,'BOOLEAN');mod.operation='DIFFERENCE';mod.solver='EXACT';mod.object=cutter
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter,do_unlink=True)

# Flat end caps stay planar; a weighted normal modifier keeps broad panel faces
# from inheriting the radial bevel's shading. Modifier is baked into the GLB.
for obj in list(scene.objects):
    if obj.type!='MESH':continue
    for p in obj.data.polygons:
        # Boolean panel n-gons still belong to the smoothly rounded chassis.
        if len(p.vertices)>4 and obj not in (chassis,seam):p.use_smooth=False
    if obj == chassis:
        bevel=obj.modifiers.new('Soft wheel arch edges','BEVEL');bevel.width=.007
        bevel.segments=3;bevel.limit_method='ANGLE';bevel.angle_limit=.6
    if obj != display:
        mod=obj.modifiers.new('Panel weighted normals','WEIGHTED_NORMAL');mod.keep_sharp=True;mod.weight=25
    tri=obj.modifiers.new('Stable export triangulation','TRIANGULATE');tri.quad_method='FIXED'

# Consistent stage for front / 3-quarter / rear / articulated visual review.
scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1000;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.world=bpy.data.worlds.new('Review world');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.10,.13,.18,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.45
scene.view_settings.view_transform='AgX'
height=1.903769
def aim(obj):obj.rotation_euler=(-obj.location).to_track_quat('-Z','Y').to_euler()
for name,direction,strength,size in [('Key',(-2,-3,3),750,2),('Fill',(3,-2,1),450,2.5),('Rim',(0,2,3),900,1.5)]:
    data=bpy.data.lights.new(name,'AREA');data.energy=strength*height*height;data.shape='DISK';data.size=size*height
    light=bpy.data.objects.new(name,data);scene.collection.objects.link(light);light.location=Vector(direction)*height;aim(light)
data=bpy.data.cameras.new('Review camera');camera=bpy.data.objects.new('Review camera',data);scene.collection.objects.link(camera);scene.camera=camera
data.type='ORTHO';data.ortho_scale=height*1.2
for name,direction in [('front',(0,-3,.12)),('three-quarter',(1.8,-3,.4)),('back',(0,3,.15)),('articulated',(1.8,-3,.4))]:
    if name=='articulated':
        yaw.rotation_euler.z=.38;pitch.rotation_euler.x=-.27
        for obj in scene.objects:
            if obj.name.startswith('wheel-steer-'):obj.rotation_euler.z=.24
            if obj.name.startswith('wheel-spin-'):obj.rotation_euler.x=.75
    camera.location=Vector(direction)*height;aim(camera)
    scene.render.filepath=str(QA/(name+'.png'));bpy.ops.render.render(write_still=True)
yaw.rotation_euler.z=0;pitch.rotation_euler.x=-.2037
for obj in scene.objects:
    if obj.name.startswith('wheel-steer-'):obj.rotation_euler.z=0
    if obj.name.startswith('wheel-spin-'):obj.rotation_euler.x=0
camera.location=Vector((1.8,-3,.4))*height;aim(camera)
bpy.ops.object.select_all(action='DESELECT')
for obj in [root]+list(root.children_recursive):obj.select_set(True)
bpy.context.view_layer.objects.active=root
# Keep machine-specific render and file-browser paths out of the shared source.
# Overwrite fixed-size string buffers, including bytes after the terminator.
scene.render.filepath = '_' * 1023
scene.render.filepath = '//output/robot-authored/articulated.png'
for screen in bpy.data.screens:
    for area in screen.areas:
        for space in area.spaces:
            if space.type == 'FILE_BROWSER' and space.params:
                space.params.directory = b'_' * 1023
                space.params.directory = b'//'
bpy.ops.wm.save_as_mainfile(filepath=str(ART/'codex-robot-authored.blend'),compress=True,relative_remap=False)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'assets/models/codex-robot-authored.glb'),export_format='GLB',use_selection=True,export_apply=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False)
print('ARTICULATED_MODEL',json.dumps({'parts':[obj.name for obj in root.children_recursive if obj.type=='MESH'],'triangles':sum(len(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.loop_triangles) for obj in root.children_recursive if obj.type=='MESH')}),flush=True)
