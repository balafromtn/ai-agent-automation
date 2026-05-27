import { generateNodeId, generateEdgeId } from '@/utils/ids';

/**
 * Deep clones an array of workflow nodes and ensures every node 
 * receives a completely unique ID, shifting their position slightly.
 * Now returns both the cloned steps and an internal translation map 
 * so edge replication can preserve internal connections.
 */
export const duplicateNodesSafely = (nodesToDuplicate: any[]): { clonedSteps: any[], idMap: Map<string, string> } => {
  const idMap = new Map<string, string>();
  
  const clonedSteps = nodesToDuplicate.map((node) => {
    const clonedNode = JSON.parse(JSON.stringify(node));
    const newId = generateNodeId(clonedNode.type);
    
    idMap.set(node.id, newId);
    clonedNode.id = newId;
    clonedNode.selected = false;
    
    if (clonedNode.position) {
      clonedNode.position.x += 40;
      clonedNode.position.y += 40;
    }
    
    return clonedNode;
  });

  return { clonedSteps, idMap };
};

/**
 * Sanitizes imported workflows/templates by translating potentially conflicting IDs.
 * NOW tracks an internal registry to guard against duplicate IDs embedded *inside* the incoming file itself.
 */
export const sanitizeImportedGraph = (
  importedNodes: any[], 
  importedEdges: any[], 
  existingNodes: any[]
) => {
  const existingIds = new Set((existingNodes || []).map((n) => n.id));
  const seenInImport = new Set<string>();
  const idMap = new Map<string, string>();

  const sanitizedNodes = (importedNodes || []).map((node) => {
    let newId = node.id;
    
    // Force regeneration if it hits a canvas conflict OR an intra-bundle collision
    if (existingIds.has(node.id) || seenInImport.has(node.id)) {
      newId = generateNodeId(node.type);
    }
    
    idMap.set(node.id, newId);
    seenInImport.add(newId);

    return {
      ...node,
      id: newId,
      selected: false,
    };
  });

  const sanitizedEdges = (importedEdges || []).map((edge) => {
    const sourceId = idMap.get(edge.source) || edge.source;
    const targetId = idMap.get(edge.target) || edge.target;

    return {
      ...edge,
      id: generateEdgeId(),
      source: sourceId,
      target: targetId,
    };
  });

  return { sanitizedNodes, sanitizedEdges };
};

/**
 * Structural Validation Layer
 * Inspects the workflow graph for schema validity before saving to the backend engine.
 */
export const validateGraphIntegrity = (nodes: any[], edges: any[]): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  // 1. Audit Node Uniqueness
  (nodes || []).forEach((node) => {
    if (!node.id) {
      errors.push("Encountered an invalid node structure missing an explicit ID token.");
      return;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`Graph Violation: Duplicate Node ID collision discovered for '${node.id}'.`);
    }
    nodeIds.add(node.id);
  });

  // 2. Audit Edge Connections and Reference Pointers
  (edges || []).forEach((edge) => {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Orphaned Reference: Edge link '${edge.id}' references a source node identifier '${edge.source}' that does not exist in the canvas state.`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Orphaned Reference: Edge link '${edge.id}' references a target node identifier '${edge.target}' that does not exist in the canvas state.`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
};