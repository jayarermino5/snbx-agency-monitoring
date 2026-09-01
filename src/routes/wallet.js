const express = require('express');
const { ghlFetch, getCompanyId } = require('../ghlClient');

const router = express.Router();

// GET /api/wallet
// Query params: sortBy (default: current YYYY-MM), sortOrder (default: desc)
// Returns all sub-accounts merged across all pages
router.get('/', async (req, res, next) => {
  try {
    const companyId = getCompanyId();
    const now = new Date();
    const defaultSort = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const sortBy = req.query.sortBy || defaultSort;
    const sortOrder = req.query.sortOrder || 'desc';
    const limit = 100;

    let skip = 0;
    let all = [];
    let total = null;

    while (true) {
      const path = `/blade-platform/warehouse/v2/location-usage-records/${companyId}?skip=${skip}&limit=${limit}&sortBy=${sortBy}&sortOrder=${sortOrder}`;
      const data = await ghlFetch(path);

      if (!data.success) {
        return res.status(502).json({ error: 'GHL wallet API returned success:false', raw: data });
      }

      all = all.concat(data.data);
      if (total === null) total = data.locationsCount;

      console.log(`[wallet] fetched ${all.length}/${total}`);

      if (all.length >= total || data.data.length < limit) break;
      skip += limit;
    }

    res.json({
      success: true,
      companyId,
      locationsCount: all.length,
      months: all.length > 0 ? Object.keys(all[0].months || {}) : [],
      data: all,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
