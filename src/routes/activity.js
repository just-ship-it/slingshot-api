import express from 'express';
import database from '../services/database.js';

const router = express.Router();

/**
 * Get recent activity with optional filtering
 */
router.get('/recent', (req, res) => {
  try {
    const { limit = 100, type } = req.query;
    let activities = database.getRecentActivity(parseInt(limit));

    // Filter by type if specified
    if (type) {
      activities = activities.filter(activity => activity.type === type);
    }

    res.json({
      success: true,
      activities,
      count: activities.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get webhook statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = database.getWebhookStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get activity types for filtering
 */
router.get('/types', (req, res) => {
  res.json({
    success: true,
    types: [
      { value: 'all', label: 'All Activity', icon: '📊' },
      { value: 'webhook', label: 'Trading Signals', icon: '📨' },
      { value: 'relay', label: 'Relay Status', icon: '🔗' },
      { value: 'system', label: 'System Events', icon: '⚙️' },
      { value: 'trade', label: 'Trade Executions', icon: '💰' },
      { value: 'error', label: 'Errors', icon: '❌' }
    ]
  });
});

export default router;