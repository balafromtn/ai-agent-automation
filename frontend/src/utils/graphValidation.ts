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
 * Structural & Step Validation Layer
 * Inspects the workflow graph for unreachable nodes, missing fields, and invalid branches.
 */
export const validateGraphIntegrity = (nodes: any[], edges: any[]): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  const nodeIds = new Set<string>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  (nodes || []).forEach(n => {
    inDegree.set(n.id, 0);
    outDegree.set(n.id, 0);
  });

  const seenIds = new Set<string>();
  (nodes || []).forEach((node) => {
    if (!node.id) {
      errors.push(`Encountered an invalid node structure missing an explicit ID (Type: ${node.type || 'Unknown'}).`);
      return;
    }
    if (seenIds.has(node.id)) {
      errors.push(`Graph Violation: Duplicate Node ID discovered for '${node.name || node.id}'.`);
    }
    seenIds.add(node.id);
    nodeIds.add(node.id);
  });

  (edges || []).forEach((edge) => {
    if (nodeIds.has(edge.source)) {
      outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
    }
    if (nodeIds.has(edge.target)) {
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }
  });

  if (nodes && nodes.length > 0) {
    const startNodes = nodes.filter(n => inDegree.get(n.id) === 0);
    
    if (startNodes.length === 0) {
      errors.push("Graph Topology: Workflow lacks a valid starting point (all nodes have incoming edges, indicating an infinite loop).");
    }

      if (nodes.length > 1) {
      nodes.forEach(n => {
        if (inDegree.get(n.id) === 0 && outDegree.get(n.id) === 0) {
          errors.push(`Graph Topology: Node '${n.name || n.type}' (ID: ${n.id}) is completely disconnected.`);
        }
      });
    }

    const visited = new Set<string>();
    const queue = [...startNodes.map(n => n.id)];
    const adj = new Map<string, string[]>();
    
    nodes.forEach(n => adj.set(n.id, []));
    (edges || []).forEach(e => {
        if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
    });

    while(queue.length > 0) {
        const current = queue.shift()!;
        if (!visited.has(current)) {
            visited.add(current);
            const neighbors = adj.get(current) || [];
            queue.push(...neighbors);
        }
    }

    nodes.forEach(n => {
        if (!visited.has(n.id) && !(inDegree.get(n.id) === 0 && outDegree.get(n.id) === 0)) {
            errors.push(`Graph Topology: Node '${n.name || n.type}' is unreachable from any starting point.`);
        }
    });
  }

  (nodes || []).forEach((node) => {
    const stepName = node.name || node.type;

    if (node.type === "LLM" || node.type === "llm") {
      if (!node.prompt || node.prompt.trim() === "") {
        errors.push(`Step Validation: LLM step '${stepName}' is missing a required prompt.`);
      }
    }

    if (node.type === "Tool" || node.type === "tool") {
      if (!node.tool) {
        errors.push(`Step Validation: Tool step '${stepName}' has no tool type selected.`);
      } else {
         if (node.tool === "email" && (!node.to || node.to.trim() === "")) {
             errors.push(`Step Validation: Email tool '${stepName}' is missing a recipient address.`);
         }
         if (node.tool === "file" && (!node.path || node.path.trim() === "")) {
             errors.push(`Step Validation: File tool '${stepName}' is missing a file path.`);
         }
         if (node.tool === "browser" && node.action !== 'evaluate' && (!node.url || node.url.trim() === "")) {
             errors.push(`Step Validation: Browser tool '${stepName}' is missing a target URL.`);
         }
      }
    }

    if (node.type === "Condition" || node.type === "condition") {
        const outEdges = (edges || []).filter(e => e.source === node.id);
        const hasTrue = outEdges.some(e => e.condition === "true" || e.label?.toLowerCase() === "true");
        const hasFalse = outEdges.some(e => e.condition === "false" || e.label?.toLowerCase() === "false");

        if (!hasTrue || !hasFalse) {
            errors.push(`Step Validation: Condition step '${stepName}' is missing a 'true' or 'false' branch connection.`);
        }
    }

    if (node.type === "Switch" || node.type === "switch") {
        const outEdges = (edges || []).filter(e => e.source === node.id);
        if (outEdges.length === 0) {
            errors.push(`Step Validation: Switch step '${stepName}' has no connected case branches.`);
        }
        outEdges.forEach(e => {
            if (!e.caseValue && !e.label) {
                errors.push(`Step Validation: Switch step '${stepName}' has an outgoing connection without a case value.`);
            }
        });
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
};