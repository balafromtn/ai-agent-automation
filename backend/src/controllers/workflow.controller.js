const Workflow = require("../models/workflow.model");
const Task = require("../models/task.model");
const workflowVersionService = require("../services/workflowVersion.service");
const { normalizeWorkflowMetadata, getWorkflowGraph } = require("../utils/workflowMetadata");
const { migrateWorkflowSteps } = require("../workflow/migrations");
const { getToolMetadata } = require("../tools/registry");
const { coreNodes } = require("../workflow/coreNodesRegistry");

const RESERVED_WORDS = [
  'steps',
  'workflow',
  'results',
  'last',
  'input',
  'output',
  'raw',
  'prompt',
  'success',
  'timestamp',
];

function validateAliases(steps) {
  if (!steps) return;
  const aliases = steps.filter((s) => s.alias).map((s) => s.alias);
  const duplicates = aliases.filter((a, i) => aliases.indexOf(a) !== i);
  if (duplicates.length) {
    throw new Error(`Duplicate aliases: ${duplicates.join(', ')}`);
  }
  const reservedCollisions = aliases.filter((a) => RESERVED_WORDS.includes(a));
  if (reservedCollisions.length) {
    throw new Error(`Alias cannot use reserved words: ${reservedCollisions.join(', ')}`);
  }
}

/** Create a new workflow */
async function createWorkflow(req, res) {
  try {
    const { name, description, agentId, metadata } = req.body;

    // Validate aliases if steps exist
    if (metadata && metadata.steps) {
      try {
        validateAliases(metadata.steps);
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    }

    const workflow = await Workflow.create({
      name,
      description,
      userId: req.user._id,
      agentId: agentId || null,
      metadata: normalizeWorkflowMetadata(metadata),
    });

    // Create initial version configuration snapshot
    await workflowVersionService.createVersionIfNeeded(workflow, req.user._id, 'Initial version');

    res.status(201).json({ ok: true, workflow });
  } catch (err) {
    console.error('createWorkflow error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** List workflows for user */
async function listWorkflows(req, res) {
  try {
    const workflows = await Workflow.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ ok: true, workflows });
  } catch (err) {
    console.error('listWorkflows error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** Get single workflow by ID */
async function getWorkflow(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.id).populate('tasks');
    if (!workflow) return res.status(404).json({ error: 'not_found' });
    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ error: 'forbidden' });
    
    let workflowObj = workflow.toObject();
    workflowObj = migrateWorkflowSteps(workflowObj);

    res.json({ ok: true, workflow: workflowObj });
  } catch (err) {
    console.error('getWorkflow error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** Update workflow */
async function updateWorkflow(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'not_found' });
    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ error: 'forbidden' });

    const allowed = ['name', 'description', 'status', 'tasks', 'agentId', 'apiSettings'];

    if (req.body.apiSettings !== undefined) {
      const { enabled, endpointName } = req.body.apiSettings;
      if (enabled) {
        if (!endpointName || typeof endpointName !== 'string' || endpointName.trim() === '') {
          return res
            .status(400)
            .json({ ok: false, error: 'Endpoint slug is required when API is enabled' });
        }
        const slugRegex = /^[a-zA-Z0-9-_]+$/;
        if (!slugRegex.test(endpointName)) {
          return res
            .status(400)
            .json({
              ok: false,
              error:
                'Endpoint slug can only contain alphanumeric characters, hyphens, and underscores',
            });
        }
        // Check uniqueness of endpointName
        const existing = await Workflow.findOne({
          _id: { $ne: workflow._id },
          'apiSettings.enabled': true,
          'apiSettings.endpointName': endpointName.trim(),
        });
        if (existing) {
          return res
            .status(400)
            .json({
              ok: false,
              error: `Endpoint slug '${endpointName}' is already in use by another workflow`,
            });
        }
      }
    }

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        workflow[key] = req.body[key];
      }
    }

    await workflow.save();

    // Create a new version if name, description, or agentId configuration details changed
    await workflowVersionService.createVersionIfNeeded(workflow, req.user._id, 'Updated details');

    res.json({ ok: true, workflow });
  } catch (err) {
    console.error('updateWorkflow error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** Delete workflow */
async function deleteWorkflow(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'not_found' });
    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ error: 'forbidden' });

    await workflow.deleteOne();
    res.json({ ok: true, message: 'workflow_deleted' });
  } catch (err) {
    console.error('deleteWorkflow error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

// Add Task to Workflow
async function addTaskToWorkflow(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.workflowId);
    if (!workflow) return res.status(404).json({ error: 'not_found' });

    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ error: 'forbidden' });

    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId_required' });

    if (workflow.tasks.includes(taskId)) {
      return res.json({
        ok: true,
        message: 'Task already exists in workflow',
        workflow,
      });
    }

    workflow.tasks.push(taskId);
    await workflow.save();

    res.json({ ok: true, workflow });
  } catch (err) {
    console.error('addTaskToWorkflow error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** Assign agent to workflow */
async function assignAgent(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.workflowId);
    if (!workflow) return res.status(404).json({ ok: false, error: 'not_found' });

    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ ok: false, error: 'forbidden' });

    const { agentId } = req.body;
    workflow.agentId = agentId || null;
    await workflow.save();

    await workflowVersionService.createVersionIfNeeded(workflow, req.user._id, 'Assigned agent');

    return res.json({ ok: true, workflow });
  } catch (err) {
    console.error('assignAgent error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** Run workflow NOW by creating a new task linked to workflow */
async function runWorkflowNow(req, res) {
  try {
    const workflowId = req.params.workflowId;

    const workflow = await Workflow.findById(workflowId);
    if (!workflow) return res.status(404).json({ ok: false, error: 'not_found' });

    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ ok: false, error: 'forbidden' });

    const { steps, edges } = getWorkflowGraph(workflow);

    if (steps.length === 0) {
      return res.status(400).json({ ok: false, error: 'workflow_has_no_steps' });
    }

    const task = await Task.create({
      name: `Workflow Run - ${workflow.name}`,
      workflowId,
      agentId: workflow.agentId || null,
      userId: req.user._id,
      input: {},
      steps,
      currentStep: 0,
      metadata: {
        steps,
        edges,
        runningBy: null,
      },
      status: 'pending',
    });

    workflow.tasks.push(task._id);
    await workflow.save();

    return res.json({ ok: true, task });
  } catch (err) {
    console.error('runWorkflowNow error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

/** Update workflow steps (PUT /api/workflows/:workflowId/steps) */
async function updateWorkflowSteps(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.workflowId);

    if (!workflow) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    if (workflow.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    let { steps, edges } = req.body;

    if (!Array.isArray(steps)) {
      return res.status(400).json({ error: 'Invalid steps' });
    }

    // Validate aliases
    try {
      validateAliases(steps);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    // Persistently normalize steps: move any root-level tool fields into config: {}
    // This permanently upgrades legacy workflow documents on every save.
    const BASE_STEP_PROPS = new Set(["stepId", "name", "type", "position", "config", "alias"]);
    steps = steps.map((s) => {
      const { cases, defaultTarget, trueTarget, falseTarget, ...rest } = s;
      const config = { ...(rest.config || {}) };

      // Hoist any root-level non-base fields into config
      for (const [key, val] of Object.entries(rest)) {
        if (!BASE_STEP_PROPS.has(key) && val !== undefined && val !== null) {
          config[key] = val;
        }
      }

      // Legacy fallback: if type is 'tool', infer the sub-type
      let finalType = rest.type;
      if (String(finalType || '').toLowerCase() === 'tool') {
        const subTool = config.tool || rest.tool;
        if (subTool) {
          finalType = String(subTool).toLowerCase();
        } else {
          // Heuristic fallback if subTool was lost
          if (config.path || (config.action && ['read','write','append','remove','list'].includes(config.action))) {
            finalType = 'file';
          } else if (config.to || config.subject) {
            finalType = 'email';
          } else if (config.url || config.action === 'evaluate') {
            finalType = 'browser';
          }
        }
      }

      return {
        stepId: rest.stepId,
        name: rest.name,
        type: finalType,
        position: rest.position,
        ...(rest.alias ? { alias: rest.alias } : {}),
        config,
      };
    });

    // Validate edges
    edges = Array.isArray(edges)
      ? edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label || '',
          condition: e.condition || null,
          caseValue: e.caseValue || null,
          animated: e.animated ?? true,
          style: e.style || { strokeWidth: 2 },
        }))
      : [];

    workflow.metadata = normalizeWorkflowMetadata({ steps, edges });
    workflow.markModified('metadata');
    await workflow.save();

    await workflowVersionService.createVersionIfNeeded(
      workflow,
      req.user._id,
      'Updated graph configuration'
    );

    return res.json({ ok: true, workflow });
  } catch (err) {
    console.error('updateWorkflowSteps error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function exportWorkflow(req, res) {
  try {
    const workflow = await Workflow.findById(req.params.workflowId);
    if (!workflow) return res.status(404).json({ ok: false, error: 'not_found' });
    if (workflow.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ ok: false, error: 'forbidden' });

    const { steps, edges } = getWorkflowGraph(workflow);

    const exportData = {
      id: workflow._id.toString(),
      name: workflow.name,
      description: workflow.description || '',
      category: '',
      icon: '',
      tags: [],
      agentId: workflow.agentId ? workflow.agentId.toString() : null,
      steps,
      edges,
    };

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${workflow.name.replace(/\s+/g, '_')}.json"`
    );
    res.setHeader('Content-Type', 'application/json');
    return res.json(exportData);
  } catch (err) {
    console.error('exportWorkflow error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function cloneWorkflow(req, res) {
  try {
    const originalWorkflow = await Workflow.findById(req.params.id);
    if (!originalWorkflow) return res.status(404).json({ ok: false, error: 'not_found' });

    if (originalWorkflow.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const clonedMetadata = JSON.parse(
      JSON.stringify(originalWorkflow.metadata || { steps: [], edges: [] })
    );

    // Validate aliases in cloned workflow
    if (clonedMetadata.steps) {
      try {
        validateAliases(clonedMetadata.steps);
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    }

    const clonedWorkflow = await Workflow.create({
      name: `${originalWorkflow.name} (Copy)`,
      description: originalWorkflow.description,
      userId: req.user._id,
      agentId: originalWorkflow.agentId || null,
      metadata: normalizeWorkflowMetadata(clonedMetadata),
    });

    await workflowVersionService.createVersionIfNeeded(
      clonedWorkflow,
      req.user._id,
      'Cloned from original'
    );

    res.status(201).json({ ok: true, workflow: clonedWorkflow });
  } catch (err) {
    console.error('cloneWorkflow error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function getNodeDefinitions(req, res) {
  try {
    const tools = getToolMetadata();
    const allNodes = [...coreNodes, ...tools];
    res.json({ ok: true, nodeDefinitions: allNodes });
  } catch (err) {
    console.error("getNodeDefinitions error", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
}

module.exports = {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  addTaskToWorkflow,
  assignAgent,
  runWorkflowNow,
  updateWorkflowSteps,
  exportWorkflow,
  cloneWorkflow,
  getNodeDefinitions
};
