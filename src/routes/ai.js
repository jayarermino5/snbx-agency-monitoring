const express = require('express');
const { ghlFetch, getCompanyId } = require('../ghlClient');

const router = express.Router();

// GET /api/ai
// Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
// Defaults to current calendar month if not provided
// Returns all sub-accounts merged across all pages
router.get('/', async (req, res, next) => {
  try {
    const companyId = getCompanyId();
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .split('T')[0];
    const today = now.toISOString().split('T')[0];

    const startDate = req.query.startDate || firstOfMonth;
    const endDate = req.query.endDate || today;
    const limit = 100;

    let skip = 0;
    let all = [];

    while (true) {
      const path = `/ai-wrapper/usage/company/locations?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}&skip=${skip}&limit=${limit}`;
      const data = await ghlFetch(path);

      if (data.status !== 'success') {
        return res.status(502).json({ error: 'GHL AI API returned non-success status', raw: data });
      }

      all = all.concat(data.data);
      console.log(`[ai] fetched ${all.length} so far, hasMore=${data.hasMore}`);

      if (!data.hasMore || data.data.length < limit) break;
      skip += limit;
    }

    res.json({
      success: true,
      companyId,
      startDate,
      endDate,
      locationsCount: all.length,
      data: all,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
