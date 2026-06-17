const { interpolate } = require('../utils/interpolate');
const { createStepResult } = require('../utils/stepResult');

async function execute(step, context, agent, validatedStepId, timeoutMs) {
  const config = step.config || step;
  const nodemailer = require('nodemailer');

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: interpolate(config.to || '', context),
    subject: interpolate(config.subject || '', context),
    text: interpolate(config.text || '', context),
    html: interpolate(config.html || '', context),
  });

  return createStepResult({
    stepId: validatedStepId,
    type: 'email',
    output: {
      messageId: info.messageId,
      accepted: info.accepted,
    },
    success: true,
  });
}

module.exports = { execute };